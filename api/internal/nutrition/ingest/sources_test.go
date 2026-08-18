package ingest

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const repoFoodDir = "../../../data/food"

// The guard that replaces a comment nobody read.
//
// Declaring a source whose file was never committed used to surface as the
// kora-api seed Job exiting 1 and crash-looping prod — three times in one day.
// The single -food-dir flag removed the two-repo drift; this removes the
// remaining way to get it wrong, by failing CI in the repo that caused it.
func TestSourceFilesExist(t *testing.T) {
	for _, name := range SourceFiles() {
		path := filepath.Join(repoFoodDir, name)
		info, err := os.Stat(path)
		require.NoErrorf(t, err, "declared source %q is not committed at api/data/food — "+
			"the seed Job would exit 1 on it", name)
		require.NotZerof(t, info.Size(), "declared source %q is empty", name)
	}
}

// Every committed data file should be declared. An orphan means either a
// source that is silently not being ingested, or a stale file left behind — a
// direction of drift the existence check above cannot see.
func TestNoUndeclaredFoodFiles(t *testing.T) {
	entries, err := os.ReadDir(repoFoodDir)
	require.NoError(t, err)

	declared := map[string]bool{}
	for _, name := range SourceFiles() {
		declared[name] = true
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		require.Truef(t, declared[e.Name()],
			"api/data/food/%s is committed but no source declares it — add it to "+
				"sources in sources.go, or delete it", e.Name())
	}
}

// Sources resolves against whatever directory it is given: `data/food` for a
// local run, `/usr/local/share/kora/food` in the image. Run sorts by full path
// and lets the alphabetically-first file win a name+brand overlap, and a
// shared prefix keeps that order identical in both.
func TestSourcesResolvesAgainstDir(t *testing.T) {
	files := Sources("/usr/local/share/kora/food")
	require.Len(t, files, len(SourceFiles())-1) // aliases are applied separately

	for path := range files {
		require.Equal(t, "/usr/local/share/kora/food", filepath.Dir(path))
	}
	require.Equal(t, "usda", files["/usr/local/share/kora/food/usda_sr_legacy.json"])
	require.Equal(t, "ausnut", files["/usr/local/share/kora/food/ausnut.json"])
	require.NotContains(t, files, "/usr/local/share/kora/food/"+AliasFile)
}
