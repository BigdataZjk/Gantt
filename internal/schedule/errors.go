package schedule

import (
	"errors"
	"fmt"
)

// 排期错误码。前端 TypeScript 实现返回相同的 code，便于表单定位与测试断言。
const (
	ErrInvalidDate          = "invalid_date"
	ErrInvalidDays          = "invalid_days"
	ErrSegmentInvalid       = "segment_invalid"
	ErrSegmentOrder         = "segment_order"
	ErrSegmentOverlap       = "segment_overlap"
	ErrSegmentNoWorkdays    = "segment_no_workdays"
	ErrRangeExceeded        = "range_exceeded"
	ErrDaysTooSmall         = "days_too_small"
	ErrNoWorkdays           = "no_workdays"
	ErrDeliveryWithoutStart = "delivery_without_start"
	ErrDeliveryBeforeStart  = "delivery_before_start"
	ErrNoSegments           = "no_segments"
	ErrIndexOutOfRange      = "index_out_of_range"
	ErrInvalidEdge          = "invalid_edge"
	ErrMarkInvalid          = "mark_invalid"
	ErrInvalidPlan          = "invalid_plan"
)

// Error 是带机器可读码的排期错误。
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

// Code 返回错误码；不是 *Error 时返回空字符串。
func Code(err error) string {
	var target *Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}

func errInvalidDate() error {
	return &Error{Code: ErrInvalidDate, Message: "日期必须是有效的 YYYY-MM-DD"}
}

func errInvalidDays() error {
	return &Error{Code: ErrInvalidDays, Message: "开发人天必须是不小于 0 的整数，且不超过 1305"}
}

func errSegmentInvalid() error {
	return &Error{Code: ErrSegmentInvalid, Message: "排期段必须包含开始和结束日期，且开始不能晚于结束"}
}

func errSegmentOrder() error {
	return &Error{Code: ErrSegmentOrder, Message: "排期段必须按开始日期升序排列"}
}

func errSegmentOverlap() error {
	return &Error{Code: ErrSegmentOverlap, Message: "排期段之间不能重叠"}
}

func errSegmentNoWorkdays() error {
	return &Error{Code: ErrSegmentNoWorkdays, Message: "每个排期段至少需要 1 个工作日"}
}

func errRangeExceeded() error {
	return &Error{Code: ErrRangeExceeded, Message: "排期日期超出支持范围或跨度超过 5 年"}
}

func errDaysTooSmall(occupied int) error {
	return &Error{Code: ErrDaysTooSmall, Message: fmt.Sprintf("前面的排期段已占 %d 人天，最后一段至少保留 1 人天", occupied)}
}

func errNoWorkdays() error {
	return &Error{Code: ErrNoWorkdays, Message: "该范围内没有可用的工作日"}
}

func errDeliveryWithoutStart() error {
	return &Error{Code: ErrDeliveryWithoutStart, Message: "设置交付日期前需要先有开始日期"}
}

func errDeliveryBeforeStart() error {
	return &Error{Code: ErrDeliveryBeforeStart, Message: "交付日期不能早于准入日期或最后一段的开始日期"}
}

func errNoSegments() error {
	return &Error{Code: ErrNoSegments, Message: "当前排期没有分段"}
}

func errIndexOutOfRange() error {
	return &Error{Code: ErrIndexOutOfRange, Message: "排期段不存在"}
}

func errInvalidEdge() error {
	return &Error{Code: ErrInvalidEdge, Message: "只支持调整 start 或 end 边界"}
}

func errMarkInvalid(side string) error {
	return &Error{Code: ErrMarkInvalid, Message: side}
}

func errInvalidPlan() error {
	return &Error{Code: ErrInvalidPlan, Message: "排期数据无效"}
}
