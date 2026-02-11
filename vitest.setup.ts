// Vitest setup file

// Mock "server-only" so server modules can be imported in tests
vi.mock("server-only", () => ({}));
