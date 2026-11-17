package auth_test

import (
	"strings"
	"testing"

	"rsm/internal/auth"
)

func TestPasswordHashAcceptsAnyNonemptyValue(t *testing.T) {
	for _, value := range []string{"a", "1", "密", "🙂", " ", "\t\n", strings.Repeat("长", 300)} {
		hash, err := auth.Hash(value)
		if err != nil {
			t.Fatalf("nonempty password rejected: %v", err)
		}
		if !auth.Verify(value, hash) || auth.Verify(value+"x", hash) || auth.Verify("", hash) {
			t.Fatal("password verification must preserve the complete original value")
		}
	}
	if _, err := auth.Hash(""); err == nil {
		t.Fatal("empty password accepted")
	}
}
