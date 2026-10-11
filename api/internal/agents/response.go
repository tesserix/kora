package agents

import (
	"encoding/json"
	"fmt"
	"io"
)

const maxResponseBytes = 1 << 20

func decodeAgentJSON(body io.Reader, out any) error {
	data, err := io.ReadAll(io.LimitReader(body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxResponseBytes {
		return fmt.Errorf("agents: response exceeds size limit")
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("agents: invalid response JSON")
	}
	return nil
}
