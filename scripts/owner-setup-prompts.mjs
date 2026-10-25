import { z } from 'zod';

export function dashboardOrigin(value) {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Use the HTTPS website address only, for example https://hr.example.com.',
    );
  return url.origin;
}

export async function promptOwnerSetup(question, defaultOrigin, write) {
  write(
    '\nHR SYSTEM — FIRST OWNER SETUP\n\n1. Enter your email and website.\n2. Review and confirm.\n3. Open your private link to choose a password and enroll your authenticator.\n\nNo owner email or password is saved in environment files.\n',
  );
  let email;
  while (!email) {
    const result = z
      .email()
      .trim()
      .toLowerCase()
      .max(254)
      .safeParse((await question('\nOwner email: ')).trim());
    if (result.success) email = result.data;
    else write('Please enter a valid email address.\n');
  }
  let origin;
  while (!origin) {
    const value = (
      await question(
        `Website address${defaultOrigin ? ` [${defaultOrigin}]` : ''}: `,
      )
    ).trim();
    try {
      origin = dashboardOrigin(value || defaultOrigin);
    } catch {
      write(
        'Enter an HTTPS address without a path, for example https://hr.example.com.\n',
      );
    }
  }
  write(
    `\nOwner email: ${email}\nWebsite: ${origin}\n\nAn enrolled owner cannot be replaced. For the same pending email, a new link invalidates the previous link.\n`,
  );
  const confirmed = (await question('Create owner setup link? [y/N]: '))
    .trim()
    .toLowerCase();
  return ['y', 'yes'].includes(confirmed) ? { email, origin } : null;
}
