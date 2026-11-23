package history

type Entry struct {
	ID         int64   `json:"id"`
	Actor      string  `json:"actor"`
	Action     string  `json:"action"`
	CreatedAt  string  `json:"createdAt"`
	Reversible bool    `json:"reversible"`
	Undone     bool    `json:"undone"`
	Detail     *Detail `json:"detail,omitempty"`
}
type Version struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Actor     string `json:"actor"`
	CreatedAt string `json:"createdAt"`
	Revision  int64  `json:"revision"`
}
