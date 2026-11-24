package server

import (
	"net/http"
	"strconv"
)

func (s *Server) reverseRequestOperation(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Base *int64 `json:"baseRevision"`
		Redo bool   `json:"redo"`
	}
	if err := decode(w, r, &in); err != nil {
		s.fail(w, err)
		return
	}
	if err := revision(in.Base); err != nil {
		s.fail(w, err)
		return
	}
	id, err := pathID(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	rev, operationID, err := s.Store.ReverseRequestOperation(r.Context(), actor(r).ID, in.Base, id, in.Redo)
	s.finishRequestOperation(w, r, rev, operationID, err)
}

func (s *Server) finishRequestOperation(w http.ResponseWriter, r *http.Request, revision, operationID int64, err error) {
	if err == nil && operationID > 0 {
		w.Header().Set("X-RSM-Request-Operation", strconv.FormatInt(operationID, 10))
	}
	s.finish(w, r, revision, err)
}
