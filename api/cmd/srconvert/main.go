// Command srconvert turns a USDA SR Legacy JSON export into the ingest row
// format. It is a BUILD-TIME tool: its output is committed to data/food and the
// binary is deliberately NOT shipped in the image.
package main

import (
	"flag"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/nutrition/ingest"
)

func main() {
	in := flag.String("in", "", "path to FoodData_Central_sr_legacy_food_json_*.json")
	out := flag.String("out", "data/food/usda_sr_legacy.json", "output path")
	flag.Parse()

	if *in == "" {
		log.Fatal("srconvert: -in required")
	}
	f, err := os.Open(*in)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()

	w, err := os.Create(*out)
	if err != nil {
		log.Fatal(err)
	}
	defer w.Close()

	stats, err := ingest.ConvertSRLegacy(f, w)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("srconvert: converted %d, skipped %d -> %s", stats.Converted, stats.Skipped, *out)
}
