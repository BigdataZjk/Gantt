package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rsm/internal/schedule"
	"rsm/internal/store"
)

type holidayTransport func(*http.Request) (*http.Response, error)

func (f holidayTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestFetchHolidayRejectsInvalidAndOversizedResponses(t *testing.T) {
	original := holidayClient
	t.Cleanup(func() { holidayClient = original })
	valid := `{"year":2028,"days":[{"name":"元旦","date":"2028-01-01","isOffDay":true}]}`
	for _, tc := range []struct {
		name, body string
		status     int
		valid      bool
	}{
		{"published", valid, 200, true},
		{"unpublished", `{"year":2028,"days":[]}`, 200, false},
		{"not-found", "", 404, false},
		{"redirect", "", 302, false},
		{"invalid", `<html>error</html>`, 200, false},
		{"oversized", valid + strings.Repeat(" ", maxCalendarBytes), 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			holidayClient = &http.Client{Transport: holidayTransport(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header), Request: r}, nil
			})}
			_, err := fetchHoliday(context.Background(), "https://example.test/2028.json", 2028)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, err=%v", tc.valid, err)
			}
		})
	}
}

func TestRefreshCalendarFallbackAndFailurePreserveState(t *testing.T) {
	db, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := New(db, nil, "test")
	var cookie *http.Cookie
	call := func(path string, body any, status int) store.Snapshot {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			req.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		app.ServeHTTP(response, req)
		if response.Code != status {
			t.Fatalf("%s: %d %s", path, response.Code, response.Body.String())
		}
		for _, item := range response.Result().Cookies() {
			if item.Name == "rsm_session" {
				cookie = item
			}
		}
		var state store.Snapshot
		if status == 200 {
			if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil {
				t.Fatal(err)
			}
		}
		return state
	}
	before := call("/api/setup", map[string]any{"password": "calendar-refresh-test"}, 200)
	original := holidayClient
	t.Cleanup(func() { holidayClient = original })
	var hosts []string
	holidayClient = &http.Client{Transport: holidayTransport(func(r *http.Request) (*http.Response, error) {
		hosts = append(hosts, r.URL.Host)
		code, body := 404, ""
		if r.URL.Host == "cdn.jsdelivr.net" {
			code, body = 200, `{"year":2028,"days":[{"name":"元旦","date":"2028-01-03","isOffDay":true}]}`
		}
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header), Request: r}, nil
	})}
	updated := call("/api/calendar/refresh", map[string]any{"baseRevision": before.Revision, "year": 2028}, 200)
	if len(hosts) != 2 || hosts[0] != "raw.githubusercontent.com" || hosts[1] != "cdn.jsdelivr.net" || schedule.IsWorkday("2028-01-03", updated.Calendar) || updated.Revision != before.Revision+1 {
		t.Fatal("calendar fallback did not publish expected revision", hosts)
	}
	holidayClient = &http.Client{Transport: holidayTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header), Request: r}, nil
	})}
	call("/api/calendar/refresh", map[string]any{"baseRevision": updated.Revision, "year": 2028}, 400)
	latest, err := db.Snapshot(context.Background(), "")
	if err != nil || latest.Revision != updated.Revision || schedule.IsWorkday("2028-01-03", latest.Calendar) {
		t.Fatal("failed refresh changed existing calendar", err)
	}
}
