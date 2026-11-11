// Failure modes: a missing legacy cookie rejects a usable publisher, or a stale cookie bypasses login/verification.
package xiaohongshu

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
)

func TestCreatorPageGate(t *testing.T) {
	bin := os.Getenv("XHS_TEST_BROWSER")
	if bin == "" {
		t.Skip("set XHS_TEST_BROWSER to run isolated browser fixtures")
	}
	l := launcher.New().Bin(bin).Headless(true).NoSandbox(true).UserDataDir(t.TempDir())
	b := rod.New().ControlURL(l.MustLaunch()).MustConnect()
	defer l.Cleanup()
	defer b.MustClose()
	ready := `<div class="creator-tab">上传图文</div><div class="upload-content"><input type="file"></div>`
	for _, tc := range []struct {
		name, path, html, want string
		legacy                 bool
	}{
		{"missing old cookie", "/publish/publish", ready, "ready", false},
		{"redirect to login with old cookie", "/login", ready, "login", true},
		{"QR over publisher", "/publish/publish", ready + `<div class="qrcode">扫码</div>`, "login", true},
		{"verification over publisher", "/publish/publish", ready + `<div>安全验证</div>`, "unknown", true},
		{"blank page", "/publish/publish", ``, "unknown", true},
		{"hidden publisher", "/publish/publish", `<div style="display:none">` + ready + `</div>`, "unknown", true},
		{"delayed publisher", "/publish/publish", `<script>setTimeout(()=>document.body.innerHTML=` + "`" + ready + "`" + `,300)</script>`, "ready", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			page := b.MustPage()
			defer page.MustClose()
			b.MustSetCookies()
			if tc.legacy {
				page.MustSetCookies(&proto.NetworkCookieParam{Name: "galaxy_creator_session_id", Value: "stale", URL: urlOfPublic})
			}
			router := page.HijackRequests()
			router.MustAdd("*", func(h *rod.Hijack) {
				if h.Request.Method() != "GET" {
					t.Error("probe made a write request")
				}
				h.Response.SetHeader("Content-Type", "text/html; charset=utf-8").SetBody(tc.html)
			})
			go router.Run()
			defer router.MustStop()
			err := checkCreatorSession(page, "https://creator.xiaohongshu.com"+tc.path, 2*time.Second)
			if tc.want == "ready" && err != nil {
				probe, probeErr := page.Eval(creatorPageProbe)
				t.Logf("probe=%v error=%v html=%s", probe, probeErr, page.MustHTML())
				t.Fatal(err)
			}
			if tc.want == "login" && !errors.Is(err, ErrCreatorLoginRequired) {
				t.Fatalf("expected login, got %v", err)
			}
			if tc.want == "unknown" && (err == nil || errors.Is(err, ErrCreatorLoginRequired)) {
				t.Fatalf("expected unknown/verification, got %v", err)
			}
		})
	}
}
