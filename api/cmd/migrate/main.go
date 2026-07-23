package main

import (
	"log"
	"os"

	"github.com/tesserix/kora/api/internal/database"
)

func main() {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		log.Fatal("migrate: DATABASE_URL or TEST_DATABASE_URL required")
	}
	if err := database.Migrate(url); err != nil {
		log.Fatal(err)
	}
}
