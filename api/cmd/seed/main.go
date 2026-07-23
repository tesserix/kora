package main

import (
	"context"
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("seed: DATABASE_URL required")
	}
	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	n, err := nutrition.Seed(context.Background(), nutrition.NewRepository(db))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("seed: inserted %d food items", n)
}
