# Login Authentication STRIDE Explanation Script

Good day. For our login and authentication module, we used STRIDE to identify possible threats and match each threat with a security control.

For Spoofing, the threat is that an unauthorized person may use another user's account. To control this, the system uses login authentication, Argon2id password hashing, account lockout, rate limiting, reCAPTCHA, and MFA for privileged roles such as System Administrator, HR Admin, Payroll Officer, and Payroll Manager.

For Tampering, the threat is that login or session parameters may be changed by the client. The system validates inputs on the server side, verifies CAPTCHA and MFA challenges on the backend, signs JWT sessions, stores refresh tokens securely, and checks active sessions through the database.

For Repudiation, the threat is that a user may deny that they logged in or deny that a failed login attempt happened. To address this, we added successful and failed login events to the System Admin Audit Trail. Each event records the event type, result, timestamp, employee reference when available, masked login identifier for failed attempts, IP address, and user agent. This supports accountability because the System Administrator can review authentication activity without exposing passwords, tokens, or MFA codes.

For Information Disclosure, the threat is that passwords, tokens, or authentication secrets may be exposed. The system never stores plaintext passwords, stores only hashed refresh tokens, encrypts TOTP MFA secrets, uses generic login error messages, and avoids showing sensitive values in audit logs.

For Denial of Service, the threat is repeated login attempts that overload the login service or repeatedly attack an account. The system uses rate limiting, CAPTCHA before expensive password checks, account lockout after repeated failures, and limited MFA attempts with short challenge expiration.

For Elevation of Privilege, the threat is that a normal user may access admin functions. The system enforces backend RBAC, validates roles from verified sessions and database records, protects admin routes, and does not rely on frontend hiding alone.

So the change we made is specifically aligned with STRIDE Repudiation. In the System Admin Audit Trail, authentication events can now be filtered under Authentication. This makes successful and failed login attempts visible to the System Administrator for monitoring, investigation, and accountability while still following secure-by-design principles.
