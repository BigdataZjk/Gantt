package upgrade

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const (
	MaxSourceBytes = 16 << 20
	zipEndSize     = 22
	commitSize     = 40
	signatureTag   = "\nRSM-Ed25519-v1:"
	signatureSize  = ed25519.SignatureSize * 2
	signedComment  = commitSize + len(signatureTag) + signatureSize
)

var (
	releaseKey, _  = hex.DecodeString("8bc68d74785e78a99fb874a34561453ead3c2ed3d24a4666b224f07eeb3bb86d")
	versionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)
	commitPattern  = regexp.MustCompile(`^[a-f0-9]{40}$`)
	ErrSignature   = errors.New("源码 ZIP 的发布签名无效，请使用正式发布的源码包")
	ErrSource      = errors.New("源码 ZIP 缺少有效的项目版本")
	ErrOlder       = errors.New("源码包版本低于当前版本")
)

// SignFile signs the exact archive bytes and stores the signature in the ZIP comment.
func SignFile(archive, keyPath string) error {
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return errors.New("发布密钥格式无效")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return errors.New("发布密钥格式无效")
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok || !bytes.Equal(key.Public().(ed25519.PublicKey), releaseKey) {
		return errors.New("发布密钥与 RSM 信任的公钥不匹配")
	}
	data, err := os.ReadFile(archive)
	if err != nil {
		return err
	}
	data, err = signSource(data, key)
	if err != nil {
		return err
	}
	return os.WriteFile(archive, data, 0600)
}

func signSource(data []byte, key ed25519.PrivateKey) ([]byte, error) {
	end := zipEnd(data, commitSize)
	if end == nil || !commitPattern.Match(data[len(data)-commitSize:]) || len(data)+len(signatureTag)+signatureSize > MaxSourceBytes {
		return nil, errors.New("无法签名：需要包含 Git 提交号且不超过 16 MiB 的源码 ZIP")
	}
	binary.LittleEndian.PutUint16(end[20:22], uint16(signedComment))
	data = append(data, signatureTag...)
	signature := ed25519.Sign(key, data)
	return hex.AppendEncode(data, signature), nil
}

func zipEnd(data []byte, commentSize int) []byte {
	if len(data) < zipEndSize+commentSize {
		return nil
	}
	end := data[len(data)-zipEndSize-commentSize:]
	if string(end[:4]) != "PK\x05\x06" || int(binary.LittleEndian.Uint16(end[20:22])) != commentSize {
		return nil
	}
	return end
}

func verifySource(data []byte, key ed25519.PublicKey) (string, error) {
	end := zipEnd(data, signedComment)
	if end == nil || !bytes.HasSuffix(data[:len(data)-signatureSize], []byte(signatureTag)) {
		return "", ErrSignature
	}
	signature, err := hex.DecodeString(string(data[len(data)-signatureSize:]))
	if err != nil || !ed25519.Verify(key, data[:len(data)-signatureSize], signature) {
		return "", ErrSignature
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", ErrSource
	}
	versionFile, err := archive.Open("rsm/web/package.json")
	if err != nil {
		return "", ErrSource
	}
	defer versionFile.Close()
	const maxManifest = 32 << 10
	manifest, err := io.ReadAll(io.LimitReader(versionFile, maxManifest+1))
	var project struct{ Version string }
	if err != nil || len(manifest) > maxManifest || json.Unmarshal(manifest, &project) != nil || !versionPattern.MatchString(project.Version) {
		return "", ErrSource
	}
	return project.Version, nil
}

func sourceDigest(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func olderVersion(target, current string) bool {
	currentParts, targetParts := strings.Split(current, "."), strings.Split(target, ".")
	for i, part := range targetParts {
		targetN, _ := strconv.Atoi(part)
		currentN, _ := strconv.Atoi(currentParts[i])
		if targetN != currentN {
			return targetN < currentN
		}
	}
	return false
}
