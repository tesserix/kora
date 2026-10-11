package agents

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/kora/api/internal/httpx"
)

// Handler exposes what Kora's agents can currently do, read live from the
// registry. It answers "which skills and tools are actually published right
// now" without a redeploy or a shell on the pod.
type Handler struct {
	coordinator *Coordinator
}

// NewHandler builds a Handler over the coordinator.
func NewHandler(c *Coordinator) Handler { return Handler{coordinator: c} }

// List returns every readable agent with its resolved skills and tools.
func (h Handler) List(c *gin.Context) {
	catalog, err := h.coordinator.Catalog(c.Request.Context())
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "agents: catalog failed", "err", err)
		httpx.Error(c, http.StatusBadGateway, "registry_unavailable", "the agent registry is unavailable")
		return
	}
	httpx.OK(c, catalog)
}

// Get returns one agent's full resolved composition, including any references
// the registry could not resolve — the thing to look at when an agent is
// answering without a skill it is supposed to have.
func (h Handler) Get(c *gin.Context) {
	resolved, err := h.coordinator.Resolve(c.Request.Context(), c.Param("name"))
	if err != nil {
		slog.ErrorContext(c.Request.Context(), "agents: resolve failed", "agent", c.Param("name"), "err", err)
		httpx.Error(c, http.StatusBadGateway, "registry_unavailable", "the agent could not be resolved")
		return
	}

	skills := resolved.Skills()
	ids := make([]string, 0, len(skills))
	for _, s := range skills {
		ids = append(ids, s.ID)
	}
	httpx.OK(c, gin.H{
		"name":       resolved.Agent.Metadata.Name,
		"tag":        resolved.Agent.Metadata.Tag,
		"digest":     resolved.Agent.Metadata.Digest,
		"skills":     ids,
		"tools":      resolved.Tools(),
		"unresolved": resolved.Unresolved,
	})
}

// Refresh drops the cached composition for one agent so the next request
// re-reads it. Publishing a new revision otherwise waits out the TTL.
func (h Handler) Refresh(c *gin.Context) {
	name := c.Param("name")
	h.coordinator.registry.Refresh(name, "")
	httpx.OK(c, gin.H{"refreshed": name})
}
