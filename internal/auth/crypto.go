package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/argon2"
)

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Disabled bool   `json:"disabled"`
	Deleted  bool   `json:"deleted"`
	Avatar   string `json:"avatar"`
}

func (u User) CanEdit() bool { return u.Role != "readonly" && !u.Disabled && !u.Deleted && u.ID != "" }
func (u User) Admin() bool {
	return (u.Role == "admin" || u.Role == "superadmin") && !u.Disabled && !u.Deleted
}
func (u User) Super() bool { return u.Role == "superadmin" && !u.Disabled && !u.Deleted }
func ValidRole(s string) bool {
	return s == "superadmin" || s == "admin" || s == "collaborator" || s == "readonly"
}
func ID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b)
}
func Token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func ValidatePassword(s string) error {
	if s == "" {
		return errors.New("密码至少 1 个字符")
	}
	return nil
}
func Hash(password string) (string, error) {
	if e := ValidatePassword(password); e != nil {
		return "", e
	}
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	sum := argon2.IDKey([]byte(password), salt, 2, 64*1024, 2, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=2,p=2$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(sum)), nil
}
func Verify(password, encoded string) bool {
	if password == "" {
		return false
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=65536,t=2,p=2" {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[4])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(parts[5])
	if e != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 2, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

type Vault struct{ aead cipher.AEAD }

func OpenVault(home string, existing bool) (*Vault, error) {
	path := filepath.Join(home, "secrets", "password.key")
	key, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		if existing {
			return nil, errors.New("数据库已存在但密码密钥缺失，请恢复匹配备份")
		}
		if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			return nil, e
		}
		key = make([]byte, 32)
		if _, e = rand.Read(key); e != nil {
			return nil, e
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return nil, err
		}
		_, e = f.Write(key)
		if e == nil {
			e = f.Sync()
		}
		closeErr := f.Close()
		if e != nil {
			return nil, e
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else if e != nil {
		return nil, e
	}
	if len(key) != 32 {
		return nil, errors.New("密码密钥长度无效")
	}
	stat, e := os.Stat(path)
	if e != nil {
		return nil, e
	}
	if stat.Mode().Perm()&0077 != 0 {
		return nil, errors.New("密码密钥权限必须为0600")
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	return &Vault{aead}, nil
}
func (v *Vault) Encrypt(userID, password string) ([]byte, error) {
	nonce := make([]byte, v.aead.NonceSize())
	if _, e := rand.Read(nonce); e != nil {
		return nil, e
	}
	return v.aead.Seal(nonce, nonce, []byte(password), []byte(userID)), nil
}
func (v *Vault) Decrypt(userID string, blob []byte) (string, error) {
	n := v.aead.NonceSize()
	if len(blob) < n {
		return "", errors.New("加密密码损坏")
	}
	b, e := v.aead.Open(nil, blob[:n], blob[n:], []byte(userID))
	if e != nil {
		return "", errors.New("密码密钥不匹配或加密密码损坏")
	}
	return string(b), nil
}
