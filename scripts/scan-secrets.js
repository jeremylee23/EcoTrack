const { execSync } = require('child_process');

// Regex patterns to detect potential secrets
const secretPatterns = [
  // Generic URL with password
  /(?:postgresql|postgres|mysql|redis|mongodb(?:\+srv)?):\/\/[^:\/\s]+:[^@\/\s]+@/i,
  // Supabase service role key (jwt format roughly)
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i,
  // Other generic tokens/secrets
  /['"](sk-[A-Za-z0-9_]{30,})['"]/i,  // OpenAI/Stripe style keys
  /LINE_CHANNEL_ACCESS_TOKEN|LINE_CHANNEL_SECRET/i
];

try {
  // Get list of staged files
  const stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM').toString().trim();
  
  if (!stagedFiles) {
    process.exit(0);
  }

  const files = stagedFiles.split('\n');
  let hasError = false;

  console.log('🔍 Running Security Check on staged files...');

  for (const file of files) {
    // Only check text files
    if (!file.match(/\.(ts|js|json|md|txt|html|sql)$/i)) continue;

    const diff = execSync(`git diff --cached "${file}"`).toString();
    
    // Only check added lines
    const addedLines = diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));

    for (let i = 0; i < addedLines.length; i++) {
      const line = addedLines[i];
      for (const pattern of secretPatterns) {
        if (pattern.test(line)) {
          console.error(`\x1b[31m[SECURITY ALERT]\x1b[0m Potential secret detected in ${file}`);
          console.error(`\x1b[33mLine:\x1b[0m ${line}`);
          hasError = true;
        }
      }
    }
  }

  if (hasError) {
    console.error('\n\x1b[31mCOMMIT BLOCKED:\x1b[0m Please remove the secrets from the code and use process.env instead!');
    console.error('If this is a false positive, run git commit with --no-verify\n');
    process.exit(1);
  }

  console.log('✅ Security Check passed!');
  process.exit(0);

} catch (error) {
  console.error('Error running security scan:', error);
  process.exit(1);
}
