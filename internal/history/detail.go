package history

type Value struct {
	Text  string `json:"text"`
	Kind  string `json:"kind,omitempty"`
	Color string `json:"color,omitempty"`
}

type Change struct {
	Subject string  `json:"subject,omitempty"`
	Field   string  `json:"field,omitempty"`
	Tags    []Value `json:"tags,omitempty"`
	Before  *Value  `json:"before,omitempty"`
	After   *Value  `json:"after,omitempty"`
	Compact string  `json:"-"`
}

type Detail struct {
	Label       string   `json:"label"`
	Subject     string   `json:"subject,omitempty"`
	Tags        []Value  `json:"tags,omitempty"`
	Changes     []Change `json:"changes,omitempty"`
	Remaining   int      `json:"remaining,omitempty"`
	Expandable  bool     `json:"expandable,omitempty"`
	SummaryOnly bool     `json:"-"`
}

func Text(text string) Value { return Value{Text: text} }

func (d *Detail) Add(field string, before, after Value) {
	if before != after {
		d.Changes = append(d.Changes, Change{Field: field, Before: &before, After: &after})
	}
}

func (d Detail) Action() string {
	if d.Subject != "" {
		return d.Label + "：" + d.Subject
	}
	return d.Label
}

func (d Detail) Preview() Detail {
	preview := d
	preview.Changes = nil
	if !d.SummaryOnly {
		for _, change := range d.Changes[:min(2, len(d.Changes))] {
			if change.Compact != "" {
				summary := Text(change.Compact)
				change.Before, change.After = nil, &summary
				preview.Expandable = true
			}
			preview.Changes = append(preview.Changes, change)
		}
	}
	preview.Remaining = len(d.Changes) - len(preview.Changes)
	preview.Expandable = preview.Expandable || preview.Remaining != 0
	return preview
}
