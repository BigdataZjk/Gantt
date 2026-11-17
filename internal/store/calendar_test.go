package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	"rsm/internal/auth"
	"rsm/internal/requests"
	"rsm/internal/schedule"
)

func TestCalendarIsIncludedInBackupAndRestore(t *testing.T) {
	ctx := context.Background()
	s := backupFixture(t)
	edition := schedule.CalendarEdition{Year: 2028, Source: "test", Days: []schedule.HolidayDay{{Name: "元旦", Date: "2028-01-03", IsOffDay: true}}, Papers: []string{}}
	_, err := s.Change(ctx, "owner", nil, "admin", "更新工作日历", false, func(tx *sql.Tx, _ *requests.Data, _ auth.User) error { return SaveCalendar(ctx, tx, edition) })
	if err != nil {
		t.Fatal(err)
	}
	before, err := ReadCalendar(ctx, s.DB)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "calendar.tar.gz")
	if _, err := s.Backup(ctx, path, "test"); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := RestoreBackup(ctx, target, path, "test"); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	after, err := ReadCalendar(ctx, restored.DB)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("calendar lost during backup/restore", err)
	}
}
