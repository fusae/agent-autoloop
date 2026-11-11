// Failure mode: the diagnostic route bypasses bearer authentication or accepts write methods.
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreatorStatusAuthentication(t *testing.T) {
	router := setupRoutes(NewAppServer(NewXiaohongshuService(), "test-secret"))
	found := false
	for _, route := range router.Routes() {
		if route.Path == "/api/v1/login/creator-status" {
			found = true
			if route.Method != http.MethodGet {
				t.Fatal("creator probe must be GET only")
			}
		}
	}
	if !found {
		t.Fatal("missing creator probe")
	}
	for _, token := range []string{"", "Bearer wrong-token"} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/login/creator-status", nil)
		request.Header.Set("Authorization", token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/login/creator-status", nil)
	request.Header.Set("Authorization", "Bearer test-secret")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", response.Code)
	}
}
