package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"rsm/internal/auth"
	"rsm/internal/history"
	"rsm/internal/requests"
)

const announcementKey = "announcement"

func readSetting(ctx context.Context, q queryer, key string, target any) error {
	var raw string
	e := q.QueryRowContext(ctx, "select payload from system_settings where key=?", key).Scan(&raw)
	if errors.Is(e, sql.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	return json.Unmarshal([]byte(raw), target)
}

func writeSetting(ctx context.Context, tx *sql.Tx, key string, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	_, e = tx.ExecContext(ctx, "insert into system_settings(key,payload) values (?,?) on conflict(key) do update set payload=excluded.payload", key, string(raw))
	return e
}

func (s *Store) SaveAnnouncement(ctx context.Context, actorID string, base *int64, text string) (int64, error) {
	detail := history.Detail{Label: "更新系统公告", SummaryOnly: true}
	return s.ChangeLogged(ctx, actorID, base, "super", &detail, false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error {
		text = strings.TrimSpace(text)
		if text == "" {
			return Bad("请输入公告内容")
		}
		var before string
		if e := readSetting(ctx, tx, announcementKey, &before); e != nil {
			return e
		}
		detail.Add("公告内容", history.Text(before), history.Text(text))
		return writeSetting(ctx, tx, announcementKey, text)
	})
}
