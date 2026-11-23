package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"

	"rsm/internal/store"
)

const p0DeliveryConfirmationHeader = "X-RSM-Confirm-P0-Delivery"

func (s *Server) withP0DeliveryConfirmation(r *http.Request, actorID string) *http.Request {
	bodyHash := sha256.New()
	if r.Body != nil {
		r.Body = struct {
			io.Reader
			io.Closer
		}{io.TeeReader(r.Body, bodyHash), r.Body}
	}
	verify := func(revision int64, changes []store.P0DeliveryChange) error {
		mac := hmac.New(sha256.New, s.confirmationKey)
		err := json.NewEncoder(mac).Encode(struct {
			ActorID  string
			Method   string
			URI      string
			BodyHash []byte
			Revision int64
			Changes  []store.P0DeliveryChange
		}{actorID, r.Method, r.RequestURI, bodyHash.Sum(nil), revision, changes})
		if err != nil {
			return err
		}
		token := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		provided := r.Header.Get(p0DeliveryConfirmationHeader)
		if provided == "" {
			return store.P0DeliveryConfirmation{Token: token, Changes: changes}
		}
		if !hmac.Equal([]byte(provided), []byte(token)) {
			return store.ErrConflict
		}
		return nil
	}
	return r.WithContext(store.WithP0DeliveryConfirmation(r.Context(), verify))
}
