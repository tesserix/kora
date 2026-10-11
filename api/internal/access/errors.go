package access

import "errors"

// ErrNotShared means the viewer holds no grant. Handlers MUST render it as 404,
// never 403: a 403 confirms the data exists and is being withheld, which leaks
// the existence of something the owner chose not to share.
var ErrNotShared = errors.New("access: not shared")
