package server

import "net/http"

func (s *Server) saveAnnouncement(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base *int64 `json:"baseRevision"`
		Text string `json:"text"`
	}
	if e := decode(w, r, &in); e != nil {
		s.fail(w, e)
		return
	}
	if e := revision(in.Base); e != nil {
		s.fail(w, e)
		return
	}
	rev, e := s.Store.SaveAnnouncement(r.Context(), actor(r).ID, in.Base, in.Text)
	s.finish(w, r, rev, e)
}
