package history

import "time"

const MaxRetentionDays = 3650

type LogPolicy struct {
	OperationRetentionDays int `json:"operationRetentionDays"`
	ArchiveRetentionDays   int `json:"archiveRetentionDays"`
}

type CleanupRun struct {
	CheckedAt         string `json:"checkedAt"`
	OperationsDeleted int    `json:"operationsDeleted"`
	ArchivesDeleted   int    `json:"archivesDeleted"`
	Bytes             int64  `json:"bytes"`
	Error             string `json:"error"`
}

type LogManagement struct {
	Policy            LogPolicy   `json:"policy"`
	OperationCount    int         `json:"operationCount"`
	OperationBytes    int64       `json:"operationBytes"`
	OldestOperationAt string      `json:"oldestOperationAt"`
	ArchiveCount      int         `json:"archiveCount"`
	ArchiveBytes      int64       `json:"archiveBytes"`
	ActiveFileCount   int         `json:"activeFileCount"`
	ActiveFileBytes   int64       `json:"activeFileBytes"`
	LastAutomatic     *CleanupRun `json:"lastAutomatic,omitempty"`
	LastManual        *CleanupRun `json:"lastManual,omitempty"`
}

type CleanupPreview struct {
	Scope           string `json:"scope"`
	Days            int    `json:"days"`
	Before          string `json:"before"`
	Revision        int64  `json:"revision"`
	Token           string `json:"token"`
	Count           int    `json:"count"`
	Bytes           int64  `json:"bytes"`
	ReversibleCount int    `json:"reversibleCount"`
}

func LogCutoff(at time.Time, days int) time.Time {
	local := at.In(time.FixedZone("Asia/Shanghai", 8*60*60))
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location()).AddDate(0, 0, -days)
}
