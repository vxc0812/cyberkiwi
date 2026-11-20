import "dotenv/config";
import { defineConfig } from "prisma/config";

// Connection string is read from DATABASE_URL (see .env.example). Never commit real credentials.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "postgresql://cyberkiwi:cyberkiwi@localhost:5433/cyberkiwi?schema=public",
  },
});
