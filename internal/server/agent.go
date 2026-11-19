package server

import (
	"net/http"
	"slices"

	"rsm/internal/requests"
	"rsm/internal/schedule"
)

type agentSnapshot struct {
	Revision      int64              `json:"revision"`
	ServerVersion string             `json:"serverVersion"`
	Calendar      schedule.Calendar  `json:"calendar"`
	Requests      []agentRequest     `json:"requests"`
	GanttRowOrder map[string][]int64 `json:"ganttRowOrder,omitempty"`
	Support       []agentSupport     `json:"support"`
}

type agentRequest struct {
	Request       requests.Request `json:"request"`
	DeveloperName string           `json:"developerName"`
	Schedule      agentSchedule    `json:"schedule"`
}

type agentSchedule struct {
	Segments       []schedule.Segment `json:"segments"`
	Gaps           []schedule.Gap     `json:"gaps"`
	ScheduledDates []string           `json:"scheduledDates"`
	ScheduledDays  int                `json:"scheduledDays"`
	Placeholder    bool               `json:"placeholder"`
}

type agentSupport struct {
	GanttRowRequestID int64    `json:"ganttRowRequestId"`
	TargetRequestID   int64    `json:"targetRequestId"`
	TargetRequestName string   `json:"targetRequestName"`
	SupporterID       string   `json:"supporterId"`
	SupporterName     string   `json:"supporterName"`
	Start             string   `json:"start"`
	End               string   `json:"end"`
	ScheduledDates    []string `json:"scheduledDates"`
	ScheduledDays     int      `json:"scheduledDays"`
}

func (s *Server) agentSnapshot(w http.ResponseWriter, r *http.Request) {
	snap, err := s.Store.Snapshot(r.Context(), "")
	if err != nil {
		s.fail(w, err)
		return
	}
	userNames := make(map[string]string, len(snap.Users))
	for _, user := range snap.Users {
		userNames[user.ID] = user.Username
	}
	requestNames := make(map[int64]string, len(snap.Requests))
	for _, row := range snap.Requests {
		requestNames[row.ID] = row.Name
	}
	out := agentSnapshot{
		Revision:      snap.Revision,
		ServerVersion: s.Version,
		Calendar:      snap.Calendar,
		Requests:      make([]agentRequest, 0, len(snap.Requests)),
		GanttRowOrder: snap.GanttRowOrder,
		Support:       []agentSupport{},
	}
	for _, row := range snap.Requests {
		plan := schedule.Plan{
			Segments: row.Segments,
			Days:     row.Days,
			Start:    row.Start,
			Delivery: row.Delivery,
			Vacation: row.Vacation,
			Overtime: row.Overtime,
		}
		plan.Delivery = schedule.DeliveryOf(plan, snap.Calendar)
		plan.Segments = schedule.EffectiveSegments(plan)
		dates := agentScheduledDates(plan, snap.Calendar)
		out.Requests = append(out.Requests, agentRequest{
			Request:       row,
			DeveloperName: userNames[row.Developer],
			Schedule: agentSchedule{
				Segments:       plan.Segments,
				Gaps:           schedule.Gaps(plan, snap.Calendar),
				ScheduledDates: dates,
				ScheduledDays:  len(dates),
				Placeholder:    schedule.Estimated(plan) && len(plan.Segments) > 0,
			},
		})
		for _, segment := range row.SupportSegments {
			dates := agentScheduledDates(schedule.Plan{
				Segments: []schedule.Segment{{Start: segment.Start, End: segment.End}},
				Vacation: row.Vacation,
				Overtime: row.Overtime,
			}, snap.Calendar)
			out.Support = append(out.Support, agentSupport{
				GanttRowRequestID: row.ID,
				TargetRequestID:   segment.RequestID,
				TargetRequestName: requestNames[segment.RequestID],
				SupporterID:       row.Developer,
				SupporterName:     userNames[row.Developer],
				Start:             segment.Start,
				End:               segment.End,
				ScheduledDates:    dates,
				ScheduledDays:     len(dates),
			})
		}
	}
	send(w, http.StatusOK, out)
}

func agentScheduledDates(plan schedule.Plan, calendar schedule.Calendar) []string {
	days := schedule.ActiveDays(plan, calendar)
	dates := make([]string, 0, len(days))
	for day := range days {
		dates = append(dates, day)
	}
	slices.Sort(dates)
	return dates
}
