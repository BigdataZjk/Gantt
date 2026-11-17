package requests

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"rsm/internal/schedule"
)

type Request struct {
	ID            int64              `json:"id"`
	Revision      int64              `json:"revision"`
	Name          string             `json:"name"`
	Priority      string             `json:"priority"`
	Status        string             `json:"status"`
	PRD           string             `json:"prd"`
	Requester     string             `json:"requester"`
	RequestedAt   string             `json:"requestedAt"`
	Domain        string             `json:"domain"`
	RequestType   string             `json:"requestType"`
	Wangyue       string             `json:"wangyue"`
	Developer     string             `json:"developer"`
	Days          float64            `json:"days"`
	Start         string             `json:"start"`
	Delivery      string             `json:"delivery"`
	Project       string             `json:"project"`
	BRD           string             `json:"brd"`
	Review        string             `json:"review"`
	Expected      string             `json:"expected"`
	Notes         string             `json:"notes"`
	Segments      []schedule.Segment `json:"segments"`
	Vacation      []string           `json:"vacation"`
	Overtime      []string           `json:"overtime"`
	Archived      bool               `json:"archived"`
	PoolEnteredAt string             `json:"poolEnteredAt,omitempty"`
	ArchivedAt    string             `json:"archivedAt,omitempty"`
}

type Domain struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type Data struct {
	Requests []Request `json:"requests"`
	Domains  []Domain  `json:"domains"`
	NextID   int64     `json:"nextId"`
}

func Empty() Data {
	return Data{Requests: []Request{}, Domains: []Domain{
		{ID: "traffic", Name: "流量域", Color: "#8b5cf6"},
		{ID: "ads", Name: "广告域", Color: "#14b8a6"},
	}, NextID: 1}
}

func Clone(d Data) Data {
	b, _ := json.Marshal(d)
	var out Data
	_ = json.Unmarshal(b, &out)
	return out
}

var chinesePunctuation = regexp.MustCompile(`[【】、，；：。！？“”‘’（）《》〈〉「」『』〔〕…—～]`)
var Color = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func Validate(r *Request, d Data, developers map[string]bool, c schedule.Calendar) error {
	return validate(r, nil, d, developers, c)
}

func ValidateUpdate(r *Request, old Request, d Data, developers map[string]bool, c schedule.Calendar) error {
	return validate(r, &old, d, developers, c)
}

func validate(r *Request, old *Request, d Data, developers map[string]bool, c schedule.Calendar) error {
	if r.Name == "" || r.Name != strings.TrimSpace(r.Name) || len([]rune(r.Name)) > 160 || chinesePunctuation.MatchString(r.Name) {
		return errors.New("需求名必填，首尾不能有空格，最多160字，不能包含中文标点")
	}
	if !oneOf(r.Priority, "P0", "P1", "P2") || !oneOf(r.Status, "待评审", "待开发", "开发中", "已完成", "HOLD") || !oneOf(r.RequestType, "常规需求", "数据需求") {
		return errors.New("优先级、状态或需求类型无效")
	}
	if strings.TrimSpace(r.Requester) == "" || len([]rune(r.Requester)) > 160 {
		return errors.New("请填写提需人")
	}
	if !validDate(r.RequestedAt) {
		return errors.New("提需日期无效")
	}
	for _, value := range []string{r.Review, r.Expected} {
		if value != "" && !validDate(value) {
			return errors.New("补充日期无效")
		}
	}
	for i, value := range []string{r.PRD, r.Wangyue, r.BRD} {
		if value == "" {
			if i == 0 {
				return errors.New("PRD 链接必填")
			}
			continue
		}
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || len(value) > 4096 {
			return errors.New("链接必须是完整的 HTTP 或 HTTPS 地址")
		}
	}
	if r.Domain != "" {
		found := false
		for _, v := range d.Domains {
			if v.Name == r.Domain {
				found = true
				break
			}
		}
		if !found {
			return errors.New("业务域不存在")
		}
	}
	if r.Developer != "" && !developers[r.Developer] && (old == nil || r.Developer != old.Developer) {
		return errors.New("开发人必须是可用的注册账号；停用或删除的账号仅保留已有需求关联")
	}
	if r.Days < 0 || r.Days > 1305 {
		return errors.New("开发人天必须在0至1305之间")
	}
	if len(r.Segments) > 128 || len(r.Notes) > 16000 || len(r.Project) > 500 {
		return errors.New("需求内容超过长度限制")
	}
	planInput := schedule.Plan{Segments: r.Segments, Days: r.Days, Start: r.Start, Delivery: r.Delivery, Vacation: r.Vacation, Overtime: r.Overtime}
	preserve := old != nil && sameGeometry(*r, *old)
	if preserve {
		planInput.Days = 0
	}
	plan, err := schedule.Normalize(planInput, c)
	if err != nil {
		return fmt.Errorf("排期无效：%w", err)
	}
	if preserve {
		plan.Days = old.Days
	} else if r.Days > 0 && plan.Start != "" && (len(plan.Vacation) > 0 || len(plan.Overtime) > 0) {
		base, effective := 0, 0
		for _, segment := range schedule.EffectiveSegments(plan) {
			base += schedule.SegmentDays(segment, c)
			effective += schedule.SegmentEffectiveDays(plan, segment, c)
		}
		if r.Days != float64(base) && r.Days != float64(effective) {
			return errors.New("开发人天与排期不一致，请重新调整人天或日期")
		}
	}
	r.Start, r.Delivery, r.Days = plan.Start, plan.Delivery, plan.Days
	r.Segments, r.Vacation, r.Overtime = plan.Segments, plan.Vacation, plan.Overtime
	if r.Segments == nil {
		r.Segments = []schedule.Segment{}
	}
	if r.Vacation == nil {
		r.Vacation = []string{}
	}
	if r.Overtime == nil {
		r.Overtime = []string{}
	}
	return nil
}

func sameGeometry(a, b Request) bool {
	if a.Start != b.Start || a.Delivery != b.Delivery || a.Days != b.Days || len(a.Segments) != len(b.Segments) {
		return false
	}
	for i, segment := range a.Segments {
		if segment.Start != b.Segments[i].Start || segment.End != b.Segments[i].End {
			return false
		}
	}
	return true
}

func validDate(s string) bool {
	t, e := time.Parse("2006-01-02", s)
	return e == nil && t.Format("2006-01-02") == s
}
func oneOf(s string, values ...string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}

func SameSchedule(a, b Request) bool {
	type fields struct {
		Domain, RequestType, Wangyue, Developer, Start, Delivery string
		Days                                                     float64
		Segments                                                 []schedule.Segment
		Vacation, Overtime                                       []string
	}
	pick := func(r Request) fields {
		if r.Segments == nil {
			r.Segments = []schedule.Segment{}
		}
		if r.Vacation == nil {
			r.Vacation = []string{}
		}
		if r.Overtime == nil {
			r.Overtime = []string{}
		}
		return fields{r.Domain, r.RequestType, r.Wangyue, r.Developer, r.Start, r.Delivery, r.Days, r.Segments, r.Vacation, r.Overtime}
	}
	x, _ := json.Marshal(pick(a))
	y, _ := json.Marshal(pick(b))
	return string(x) == string(y)
}
