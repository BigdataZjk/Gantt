package settings

import (
	"encoding/json"
	"errors"
	"rsm/internal/requests"
)

type Preferences struct {
	Theme              string            `json:"theme"`
	Density            string            `json:"density"`
	DefaultPriority    string            `json:"defaultPriority"`
	DefaultRequestType string            `json:"defaultRequestType"`
	DomainColors       map[string]string `json:"domainColors"`
	UI                 map[string]any    `json:"ui"`
}

func Default() Preferences {
	return Preferences{Theme: "system", Density: "compact", DefaultPriority: "P1", DefaultRequestType: "常规需求", DomainColors: map[string]string{}, UI: map[string]any{}}
}
func (p *Preferences) Validate() error {
	if p.Theme != "light" && p.Theme != "dark" && p.Theme != "system" {
		return errors.New("主题无效")
	}
	if p.Density != "compact" && p.Density != "comfortable" {
		return errors.New("密度无效")
	}
	if p.DefaultPriority != "P0" && p.DefaultPriority != "P1" && p.DefaultPriority != "P2" {
		return errors.New("默认优先级无效")
	}
	if p.DefaultRequestType != "常规需求" && p.DefaultRequestType != "数据需求" {
		return errors.New("默认需求类型无效")
	}
	if p.DomainColors == nil {
		p.DomainColors = map[string]string{}
	}
	if p.UI == nil {
		p.UI = map[string]any{}
	}
	for _, color := range p.DomainColors {
		if !requests.Color.MatchString(color) {
			return errors.New("颜色无效")
		}
	}
	b, e := json.Marshal(p)
	if e != nil || len(b) > 65536 {
		return errors.New("偏好数据过大")
	}
	return nil
}
