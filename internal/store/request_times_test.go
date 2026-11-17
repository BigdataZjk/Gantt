package store

import (
	"context"
	"encoding/json"
	"testing"

	"rsm/internal/requests"
)

func TestRequestTimeBackfillStopsAtHistoryGap(t *testing.T) {
	for _, tc := range []struct {
		name string
		gap  any
	}{{"missing", nil}, {"invalid", "invalid-json"}, {"incomplete", "{}"}, {"null", "null"}} {
		t.Run(tc.name, func(t *testing.T) {
			s, err := Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			ctx := context.Background()
			data, revision, err := readData(ctx, s.DB)
			if err != nil {
				t.Fatal(err)
			}
			empty, _ := json.Marshal(data)
			data.Requests = []requests.Request{{ID: 1, Revision: 4, Name: "旧需求", Archived: true}}
			data.NextID = 2
			current, _ := json.Marshal(data)
			if _, err = s.DB.Exec("update metadata set payload=? where id=1", string(current)); err != nil {
				t.Fatal(err)
			}
			if _, err = s.DB.Exec("insert into history(actor,action,created_at,reversible,before_data) values ('admin','新建','2026-11-17T00:00:00Z',1,?)", string(empty)); err != nil {
				t.Fatal(err)
			}
			if _, err = s.DB.Exec("insert into history(actor,action,created_at,reversible,before_data) values ('admin','历史缺口','2026-11-18T00:00:00Z',0,?)", tc.gap); err != nil {
				t.Fatal(err)
			}
			if err = s.backfillRequestTimes(ctx); err != nil {
				t.Fatal(err)
			}
			var payload string
			var afterRevision int64
			if err = s.DB.QueryRow("select payload,revision from metadata where id=1").Scan(&payload, &afterRevision); err != nil {
				t.Fatal(err)
			}
			if payload != string(current) || afterRevision != revision {
				t.Fatal("history gap caused invented timestamps or modified request data")
			}
		})
	}
}
