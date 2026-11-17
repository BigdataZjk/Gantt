package schedule

import (
	"fmt"
	"reflect"
	"strings"
)

// SequenceRequest 是顺排预览中的一条需求。调用方只需传入未归档、未删除的需求；
// Developer 为开发人，Selected 表示本次多选是否勾选。Plan 必须已通过 Normalize。
type SequenceRequest struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Developer string `json:"developer"`
	Selected  bool   `json:"selected"`
	Plan      Plan   `json:"plan"`
}

// SequenceChange 是一条顺排变更：After 即应用后的排期。
type SequenceChange struct {
	ID       string `json:"id"`
	Before   Plan   `json:"before"`
	After    Plan   `json:"after"`
	Selected bool   `json:"selected"`
}

// SequenceResult 是顺排预览结果：changes 为待应用的变更，warnings 为无法自动消除的约束。
type SequenceResult struct {
	Changes       []SequenceChange `json:"changes"`
	Warnings      []string         `json:"warnings"`
	SelectedCount int              `json:"selectedCount"`
}

// Sequence 计算顺排预览：按开发人独立处理，选中需求依次向后贴紧；
// 未选中的中间需求保持与前后的衔接与交叠关系，因此可能作为随动需求进入 changes。
// 分段之间的工作日空档（真 HOLD）保持不变；无法保持约束时写入 warnings。
// 本函数只返回预览，不修改入参；应用由调用方根据 changes 写回。
func Sequence(requests []SequenceRequest, c Calendar) (SequenceResult, error) {
	idx := newCalendarIndex(c)
	normalized := make([]SequenceRequest, len(requests))
	for i, request := range requests {
		plan, err := Normalize(request.Plan, c)
		if err != nil {
			return SequenceResult{}, err
		}
		normalized[i] = request
		normalized[i].Plan = plan
	}
	result := SequenceResult{Changes: []SequenceChange{}, Warnings: []string{}}
	warned := map[string]bool{}
	addWarning := func(message string) {
		if message == "" || warned[message] {
			return
		}
		warned[message] = true
		result.Warnings = append(result.Warnings, message)
	}

	developers := []string{}
	seenDeveloper := map[string]bool{}
	for _, request := range normalized {
		if !request.Selected || !sequenceEligible(request, c) {
			continue
		}
		result.SelectedCount++
		if !seenDeveloper[request.Developer] {
			seenDeveloper[request.Developer] = true
			developers = append(developers, request.Developer)
		}
	}

	for _, developer := range developers {
		rows := make([]SequenceRequest, 0, len(normalized))
		for _, request := range normalized {
			if request.Developer == developer && sequenceEligible(request, c) {
				rows = append(rows, request)
			}
		}
		sortSequenceRows(rows)
		blocks := buildBlocks(rows)
		for _, block := range blocks {
			chosen := make([]SequenceRequest, 0, len(block))
			locked := make([]SequenceRequest, 0, len(block))
			for _, row := range block {
				if row.Selected {
					chosen = append(chosen, row)
				} else {
					locked = append(locked, row)
				}
			}
			if len(chosen) > 1 && len(locked) > 0 {
				overlap := false
				for i := 1; i < len(block); i++ {
					if Overlaps(block[i-1].Plan, block[i].Plan, c) {
						overlap = true
						break
					}
				}
				if overlap {
					addWarning(fmt.Sprintf("%s：“%s”未选中，需保持其与前后需求的衔接和交叠关系；“%s”不能分开顺排。",
						developer, joinRequestNames(locked), joinRequestNames(chosen)))
				}
			}
		}

		placed := make([]SequenceRequest, 0, len(rows))
		for _, block := range blocks {
			latest := ""
			for _, row := range placed {
				if delivery := DeliveryOf(row.Plan, c); delivery > latest {
					latest = delivery
				}
			}
			start := block[0].Plan.Start
			if latest != "" {
				if earliest := idx.nextWorkday(AddDays(latest, 1)); earliest > start {
					start = earliest
				}
			}
			moved := make([]Plan, 0, len(block))
			if start != block[0].Plan.Start {
				plans, err := moveBlock(block, start, c, idx)
				if err != nil {
					addWarning(developer + "：" + err.Error())
				} else {
					moved = plans
				}
			}
			placedBlock := make([]SequenceRequest, 0, len(block))
			for i, row := range block {
				next := row
				if len(moved) == len(block) {
					next.Plan = moved[i]
				}
				placedBlock = append(placedBlock, next)
				if !reflect.DeepEqual(row.Plan, next.Plan) {
					result.Changes = append(result.Changes, SequenceChange{
						ID:       row.ID,
						Before:   row.Plan,
						After:    next.Plan,
						Selected: row.Selected,
					})
				}
			}
			placed = append(placed, placedBlock...)
		}

		chosen := make([]SequenceRequest, 0, len(placed))
		for _, row := range placed {
			if row.Selected {
				chosen = append(chosen, row)
			}
		}
		for a := 0; a < len(chosen); a++ {
			for b := a + 1; b < len(chosen); b++ {
				if !Overlaps(chosen[a].Plan, chosen[b].Plan, c) {
					continue
				}
				left := rowIndexOf(rows, chosen[a].ID)
				right := rowIndexOf(rows, chosen[b].ID)
				if left > right {
					left, right = right, left
				}
				between := make([]SequenceRequest, 0, right-left)
				for _, row := range rows[left+1 : right] {
					if !row.Selected {
						between = append(between, row)
					}
				}
				constraint := "受未选需求或特殊日期约束"
				if len(between) > 0 {
					constraint = fmt.Sprintf("中间的“%s”未选中，需要保持前后关系", joinRequestNames(between))
				}
				addWarning(fmt.Sprintf("%s：“%s”与“%s”仍有交叠；%s。",
					developer, requestLabel(chosen[a]), requestLabel(chosen[b]), constraint))
			}
		}
	}
	return result, nil
}

func sequenceEligible(request SequenceRequest, c Calendar) bool {
	if request.Developer == "" {
		return false
	}
	if !ValidDate(request.Plan.Start) {
		return false
	}
	return ValidDate(DeliveryOf(request.Plan, c))
}

func sortSequenceRows(rows []SequenceRequest) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0; j-- {
			left, right := rows[j-1], rows[j]
			if left.Plan.Start < right.Plan.Start || (left.Plan.Start == right.Plan.Start && left.ID <= right.ID) {
				break
			}
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}

// buildBlocks 与原型一致：连续勾选的需求组成一个整体一起后移，
// 未勾选需求单独成块（只有被前一块推后才能随动）。
func buildBlocks(rows []SequenceRequest) [][]SequenceRequest {
	blocks := [][]SequenceRequest{}
	for i, row := range rows {
		if i == 0 || (rows[i-1].Selected && row.Selected) {
			blocks = append(blocks, []SequenceRequest{})
		}
		blocks[len(blocks)-1] = append(blocks[len(blocks)-1], row)
	}
	return blocks
}

func rowIndexOf(rows []SequenceRequest, id string) int {
	for i, row := range rows {
		if row.ID == id {
			return i
		}
	}
	return -1
}

func requestLabel(request SequenceRequest) string {
	if request.Name != "" {
		return request.Name
	}
	return request.ID
}

func joinRequestNames(rows []SequenceRequest) string {
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, requestLabel(row))
	}
	return strings.Join(names, "、")
}

// moveBlock 依次移动一个块内的需求，保持块内需求原有的衔接关系与交叠天数。
func moveBlock(block []SequenceRequest, start string, c Calendar, idx *calendarIndex) ([]Plan, error) {
	plans := make([]Plan, len(block))
	for i := range block {
		target := start
		if i > 0 {
			working, offset := scheduleRelation(block[i-1].Plan, block[i].Plan, c, idx)
			previous := plans[i-1].Delivery
			if working {
				target = idx.shiftWorkdays(previous, offset)
			} else {
				target = AddDays(previous, offset)
			}
			if target == "" {
				return nil, errRangeExceeded()
			}
		}
		next, err := movePlan(block[i].Plan, c, idx, target)
		if err != nil {
			return nil, err
		}
		if i > 0 {
			beforeWorking, beforeOffset := scheduleRelation(block[i-1].Plan, block[i].Plan, c, idx)
			afterWorking, afterOffset := scheduleRelation(plans[i-1], next, c, idx)
			if beforeWorking != afterWorking || beforeOffset != afterOffset ||
				OverlapDays(block[i-1].Plan, block[i].Plan, c) != OverlapDays(plans[i-1], next, c) {
				return nil, relationErrorf("无法同时保持未选需求的原有关系和交叠天数，请一并勾选相邻需求")
			}
		}
		plans[i] = next
	}
	return plans, nil
}

// scheduleRelation 描述相邻需求的关系：两端都是工作日时按工作日间隔，否则按自然日间隔。
func scheduleRelation(previous, next Plan, c Calendar, idx *calendarIndex) (bool, int) {
	end := DeliveryOf(previous, c)
	if end == "" || next.Start == "" {
		return false, 0
	}
	if idx.isWorkday(end) && idx.isWorkday(next.Start) {
		return true, idx.workingOffset(end, next.Start)
	}
	return false, daySpan(end, next.Start)
}
