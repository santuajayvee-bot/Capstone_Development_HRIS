-- DOWN migration: remove Mocean MFA challenge state only.
-- employees.contact_number is an existing LGSV HR field and is intentionally retained.

DROP TABLE IF EXISTS MFA_CHALLENGE;
