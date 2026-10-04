package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	firebase "firebase.google.com/go/v4"
	"github.com/golang-jwt/jwt/v4"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/option"
)

func TestVerifierRejectsDisabledDeletedAndRevokedUsers(t *testing.T) {
	t.Setenv("FIREBASE_AUTH_EMULATOR_HOST", "")
	now := time.Now()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	require.NoError(t, err)
	certificates := map[string]string{"fixture-key": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))}
	for _, state := range []string{"active", "disabled", "deleted", "revoked"} {
		t.Run(state, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body any = certificates
				if strings.Contains(r.URL.Path, "accounts:lookup") {
					users := []map[string]any{}
					if state != "deleted" {
						validSince := now.Unix() - 3600
						if state == "revoked" {
							validSince = now.Unix()
						}
						users = append(users, map[string]any{"localId": "fixture-user", "disabled": state == "disabled", "validSince": strconv.FormatInt(validSince, 10)})
					}
					body = map[string]any{"users": users}
				} else {
					require.Contains(t, r.URL.Path, "securetoken@system.gserviceaccount.com")
				}
				data, err := json.Marshal(body)
				require.NoError(t, err)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(data)
			}))
			defer server.Close()
			transport := server.Client().Transport.(*http.Transport).Clone()
			transport.TLSClientConfig.ServerName = "example.com"
			transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
			}
			previous := http.DefaultTransport
			http.DefaultTransport = transport
			defer func() { http.DefaultTransport = previous; transport.CloseIdleConnections() }()
			client := &http.Client{Transport: transport}
			app, err := firebase.NewApp(t.Context(), &firebase.Config{ProjectID: "kora-ci"}, option.WithHTTPClient(client), option.WithoutAuthentication())
			require.NoError(t, err)
			sdk, err := app.Auth(t.Context())
			require.NoError(t, err)
			verifier := firebaseVerifier{client: sdk}
			token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": "https://securetoken.google.com/kora-ci", "aud": "kora-ci", "sub": "fixture-user", "iat": now.Unix() - 60, "exp": now.Unix() + 3600, "auth_time": now.Unix() - 120})
			token.Header["kid"] = "fixture-key"
			signed, err := token.SignedString(key)
			require.NoError(t, err)
			claims, err := verifier.Verify(t.Context(), signed)
			if state == "active" {
				require.NoError(t, err)
				require.Equal(t, "fixture-user", claims.UID)
			} else {
				require.Error(t, err)
				require.Empty(t, claims.UID)
			}
		})
	}
}
