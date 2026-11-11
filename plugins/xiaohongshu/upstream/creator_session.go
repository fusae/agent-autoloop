package xiaohongshu

import (
	_ "embed"
	"errors"
	"fmt"
	"time"

	"github.com/go-rod/rod"
)

// Cookie names are not proof of either an authenticated or an expired creator session.
//
//go:embed creator-page.js
var creatorPageProbe string

var ErrCreatorLoginRequired = errors.New("创作者中心登录失效，请重新扫码登录")

func ensureCreatorSession(page *rod.Page) error {
	return CheckCreatorSession(page)
}

// CheckCreatorSession shares the publish gate without uploading, clicking or saving cookies.
func CheckCreatorSession(page *rod.Page) error {
	return checkCreatorSession(page, urlOfPublic, 15*time.Second)
}

func checkCreatorSession(page *rod.Page, target string, timeout time.Duration) error {
	page = page.Timeout(timeout)
	defer page.CancelTimeout()
	if err := page.Navigate(target); err != nil {
		return fmt.Errorf("打开创作者发布页失败: %w", err)
	}
	// A blank page, timeout or unknown UI must never ask the owner to scan a QR code.
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		result, err := page.Eval(creatorPageProbe)
		if err == nil {
			switch result.Value.Str() {
			case "ready":
				return nil
			case "login":
				return ErrCreatorLoginRequired
			case "verification":
				return errors.New("创作者中心要求平台验证，请本人查看页面")
			}
		}
		select {
		case <-page.GetContext().Done():
			return errors.New("创作者发布页状态未知，请维护者检查页面或网络")
		case <-ticker.C:
		}
	}
}
