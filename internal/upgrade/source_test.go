package upgrade

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"
)

func sourceArchive(t *testing.T, manifest string) []byte {
	t.Helper()
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	if err := archive.SetComment(strings.Repeat("a", commitSize)); err != nil {
		t.Fatal(err)
	}
	file, err := archive.Create("rsm/web/package.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write([]byte(manifest)); err != nil {
		t.Fatal(err)
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestSourceSignatureCoversExactArchive(t *testing.T) {
	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	unsigned := sourceArchive(t, `{"version":"0.1.10"}`)
	if _, err = verifySource(unsigned, public); !errors.Is(err, ErrSignature) {
		t.Fatalf("unsigned ZIP accepted: %v", err)
	}
	signed, err := signSource(bytes.Clone(unsigned), private)
	if err != nil {
		t.Fatal(err)
	}
	if version, err := verifySource(signed, public); err != nil || version != "0.1.10" {
		t.Fatalf("signed ZIP rejected: %q (%v)", version, err)
	}
	if _, err = verifySource(signed, releaseKey); !errors.Is(err, ErrSignature) {
		t.Fatalf("untrusted signing key accepted: %v", err)
	}
	tampered := bytes.Clone(signed)
	tampered[10] ^= 1
	for _, data := range [][]byte{tampered, signed[:len(signed)-1], append(bytes.Clone(signed), 0)} {
		if _, err = verifySource(data, public); !errors.Is(err, ErrSignature) {
			t.Fatalf("altered ZIP accepted: %v", err)
		}
	}
	invalid, err := signSource(sourceArchive(t, `{"version":"0.1.10-dev"}`), private)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = verifySource(invalid, public); !errors.Is(err, ErrSource) {
		t.Fatalf("invalid release version accepted: %v", err)
	}
}

func TestOlderVersion(t *testing.T) {
	for _, test := range []struct {
		target, current string
		older           bool
	}{
		{"0.1.9", "0.1.10", true},
		{"0.1.10", "0.1.9", false},
		{"0.1.10", "0.1.10", false},
		{"0.9.9", "1.0.0", true},
	} {
		if olderVersion(test.target, test.current) != test.older {
			t.Errorf("olderVersion(%q, %q) should return %t", test.target, test.current, test.older)
		}
	}
}
