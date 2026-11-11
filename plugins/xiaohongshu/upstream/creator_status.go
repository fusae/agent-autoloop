package main

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/xpzouying/xiaohongshu-mcp/xiaohongshu"
)

func (s *AppServer) creatorStatusHandler(c *gin.Context) {
	b := newBrowser()
	defer b.Close()
	page := b.NewPage().Context(c.Request.Context())
	defer page.Close()
	err := xiaohongshu.CheckCreatorSession(page)
	if errors.Is(err, xiaohongshu.ErrCreatorLoginRequired) {
		respondSuccess(c, gin.H{"is_logged_in": false, "can_publish": false}, "创作者中心未登录")
		return
	}
	if err != nil {
		respondError(c, http.StatusServiceUnavailable, "CREATOR_STATUS_UNKNOWN", "创作者发布页状态未知", nil)
		return
	}
	respondSuccess(c, gin.H{"is_logged_in": true, "can_publish": true}, "创作者中心已登录，可发布")
}
