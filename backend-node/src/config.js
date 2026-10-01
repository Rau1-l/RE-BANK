import 'dotenv/config';

const required = ['DATABASE_URL', 'JWT_SECRET'];
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  nodeEnv: process.env.NODE_ENV || 'development'
};
