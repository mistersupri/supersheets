// Imported first: libuv reads this when the thread pool starts. Password
// hashing (argon2) runs there, so a larger pool keeps logins fast under load.
process.env.UV_THREADPOOL_SIZE ??= '16';
