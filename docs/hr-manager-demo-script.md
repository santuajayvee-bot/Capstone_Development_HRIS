# LGSV HR HR Manager Demonstration Script

This script is for demonstrating the LGSV HR system using an HR Manager or HR Manager Level 2 account. In the local seeded build, the `hr.admin` account may be migrated and displayed as `HR Manager (Level 2)`. Use the assigned demo credentials privately, and do not show passwords, MFA codes, tokens, or raw database values during the presentation.

## Demo Goal

Show how the HR Manager manages the secure employee lifecycle:

1. Configure organization setup.
2. Register or route a new employee/applicant.
3. Review onboarding, requirements, screening, training, approval, transfer, and Level 1 employee account creation.
4. Manage employee records and 201-file data.
5. Validate attendance and corrections.
6. Manage leave requests, policies, balances, and audit reports.
7. Generate HR-accessible reports.
8. Demonstrate offboarding and re-onboarding as part of the employee lifecycle.

## Presenter Opening

"Good day. Today we will demonstrate LGSV HR, a secure web-based Human Resource and Payroll System for Marulas Industrial Corporation. For this walkthrough, I am using an HR Manager account. This role has access to employee lifecycle management, onboarding, attendance validation, leave management, reports, organization setup, and the HR dashboard. The system follows strict role-based access control, so HR Manager actions are limited to HR operations and do not replace payroll final approval or system administration."

"The focus of this demonstration is the employee lifecycle: from configuring departments and job positions, to onboarding, employee record management, attendance, leave, reporting, and eventual offboarding or re-onboarding."

## 1. Login and Role-Based Access

Screen action:

1. Open the LGSV HR login page.
2. Enter the prepared HR Manager username.
3. Enter the password privately.
4. If MFA is prompted, enter the verification code privately.
5. Confirm that the sidebar shows the HR Manager accessible modules.

Presenter says:

"The login process verifies the user account and role before allowing access to the system. If MFA is enabled for privileged roles, the user must complete the second verification step. After login, the sidebar only displays modules allowed for this HR Manager role. This shows that access is controlled by role-based permissions, not simply by hiding buttons in the interface."

Expected modules visible for HR Manager:

- Dashboard
- Employees
- Organization Setup
- Leave Management
- Attendance
- Reports
- On-Boarding
- My Profile

Security point:

"The HR Manager account does not have System Admin functions such as changing RBAC permissions, and does not have Payroll Manager authority for final payroll approval."

## 2. Dashboard Module

Screen action:

1. Click `Dashboard`.
2. Point to the welcome message and role badge.
3. Point to the dashboard cards.
4. Scroll through the dashboard tables and right-side panels.

Presenter says:

"The dashboard gives the HR Manager a quick operational summary. It shows the total employees, active employees, new hires, employees currently on leave, pending leave requests, pending onboarding items, and the attendance validation queue."

"Below the cards, the system shows actionable HR tables such as the attendance validation queue, recent leave requests, new employee registrations, and pending onboarding tracking. On the side, the HR Manager can use quick actions to open employee registration, employee account creation, leave review, and reports."

Functions to demonstrate:

- Role-aware welcome and role badge.
- Summary cards for HR workload.
- Attendance validation queue.
- Recent leave requests.
- New employee registrations.
- Pending onboarding tracking.
- Quick actions.
- Notifications.
- Pending tasks.
- Recent activities.

Security point:

"Dashboard activity is logged, and the data shown here depends on the user's verified role and permissions."

## 3. Organization Setup Module

Screen action:

1. Click `Organization Setup`.
2. Show `Add Department`.
3. Show `Add Position`.
4. Show `Employee ID Configuration`.
5. Show the Departments table.
6. Show the Positions table and filters.

Presenter says:

"Before adding employees, HR configures the basic organization structure. This includes departments, positions or job titles, and employee ID generation rules. These values are reused by employee registration, profile management, and onboarding route decisions."

Step-by-step:

1. Add a department:
   - Enter a department name, for example `Quality Assurance`.
   - Click `Add Department`.
   - Explain that the new department becomes available in employee forms.

2. Add a position:
   - Select a department.
   - Enter a job title, for example `QA Inspector`.
   - Click `Add Position`.
   - Explain that each position is mapped to a department.

3. Configure employee ID rules:
   - Show prefix, starting number, number padding, current sequence, and auto-generate setting.
   - Explain that HR can keep IDs consistent, for example `EMP000001`.

4. Manage departments:
   - Show department name, number of positions, status, and actions.
   - Demonstrate edit or deactivate if using sample data.

5. Manage positions:
   - Use search.
   - Filter by department.
   - Filter by active or inactive status.
   - Change rows per page.
   - Reset filters.
   - Demonstrate edit or deactivate if using sample data.

Functions to demonstrate:

- Add department.
- Add position.
- Save employee ID configuration.
- Edit department.
- Deactivate department.
- Edit position.
- Deactivate position.
- Search and filter positions.
- Position pagination.

Presenter bridge:

"Now that the organization structure is ready, we can move into the employee lifecycle. The next part starts with employee intake and onboarding."

## 4. Employee Management Module - Directory and Intake

Screen action:

1. Click `Employees`.
2. Show the employee directory table.
3. Use search, department filter, and status filter.
4. Click an employee row to open the profile.
5. Return to the directory.
6. Click `Add Employee`.

Presenter says:

"The Employee Management module is the HR Manager's central workforce directory. It shows employee ID, name, contact details, city, department, position, supervisor, employment status, and row actions. HR can filter employees by search keyword, department, and employment status."

Directory functions to demonstrate:

- Search employees.
- Filter by department.
- Filter by employment status.
- Paginate employee list.
- View employee profile by clicking a row.
- Open row action menu.
- Mark status such as Active, Inactive, Resigned, Terminated, End of Contract, Suspended, Retired, Offboarded, or Rehired.
- Offboard active employees.
- Re-onboard eligible separated employees.
- View pending offboarding or re-onboarding request.

## 5. Employee Intake Form

Screen action:

1. From Employees, click `Add Employee`.
2. Show the `Employee Intake` page.
3. Walk through each tab without necessarily saving real data.

Presenter says:

"The employee intake form collects the full employee record. It is divided into tabs so HR can complete the record in an organized way."

Personal Info tab:

- Employee ID mode: auto-generate or use an existing employee ID.
- Photo upload.
- First name, middle name, last name, suffix.
- Date and place of birth.
- Gender, nationality, civil status, blood type, religion.

Contact Info tab:

- Mobile number.
- Personal email and work email.
- Permanent home address.
- Current address.
- Mailing address.
- Same-as-home address shortcuts.
- Emergency contact details.

Employment Info tab:

- Department.
- Position or job title.
- Employment type.
- Hiring classification: Direct Hire or Agency-Hired.
- Employment status.
- Date hired and end of contract.
- Immediate supervisor.
- Work location.
- Shift schedule.
- Employee level.
- Onboarding or training decision.
- Agency deployment fields when Agency-Hired is selected.
- Employment history notes.

Compensation tab:

- Wage type: Base Salary, Hourly, Per-Piece, or Per-Trip.
- Allowances.
- Payroll schedule.
- Base salary, hourly rate, overtime rate, per-piece rates, or per-trip rates depending on wage type.
- Bank name and bank account number.
- Government numbers: TIN, SSS, PhilHealth, Pag-IBIG.

Documents tab:

- Resume or CV.
- Government ID.
- NBI clearance.
- Other documents.

Draft archive:

- Save a partial employee intake draft.
- Load a draft.
- Delete a draft.
- Clear all drafts.

Presenter says:

"The onboarding decision is important. HR may route the record directly as active, require screening, require training, or place it on hold. For production, operator, piece-rate, factory, and logistics helper positions, the system can route the record into onboarding by default."

If demonstrating a route to onboarding:

1. Fill minimum required personal, contact, and employment fields.
2. Choose a position.
3. In `Onboarding / Training Decision`, select `Needs screening / requirements check`, `Needs training`, or `On hold / HR review`.
4. Add an HR note if required.
5. Click save.
6. Confirm the success message says the record was routed to onboarding.
7. Let the system navigate to On-Boarding.

Security point:

"Sensitive employee data, government identifiers, payroll data, bank data, and documents are handled as protected HR records. HR Manager can manage the lifecycle, but payroll finalization and system-wide RBAC remain separate authorities."

## 6. On-Boarding Module

Screen action:

1. Click `On-Boarding`.
2. Show the summary cards.
3. Show the Applicants tab.
4. Use search and workflow status filter.
5. Open an applicant using `Review`.

Presenter says:

"The On-Boarding module manages pre-employment records before they become official employee directory records. This supports a secure lifecycle: applicant, screening, training, HR approval, transfer to employee directory, and employee account creation."

Dashboard functions:

- Total applicants.
- Active workflow.
- In screening.
- In training.
- Ready to transfer.
- Transferred.

Applicants tab functions:

- Search applicant, applicant code, or position.
- Filter by workflow status.
- Refresh the list.
- Review applicant details.

Applicant review functions:

1. Review employment details:
   - Hiring source.
   - Applied position.
   - Department.
   - Branch.
   - Employment type.
   - Shift.

2. Review contact and personal information:
   - Email.
   - Contact number.
   - Birth details.
   - Residential address.
   - Emergency contact.

3. Review payroll and secure references:
   - Expected wage type or rate if prepared.
   - Government ID preparation status.
   - Bank detail preparation status.
   - Biometric reference status.

4. Update workflow:
   - Screening status.
   - Training status.
   - Save progress.

5. Record HR approval decision:
   - Approved.
   - Rejected.
   - For Re-evaluation.
   - On Hold.

6. Manage prepared 201-file documents:
   - Select document type.
   - Upload document.
   - Download document.
   - Verify document.
   - Reject document with reason.

7. Transfer approved hire:
   - Available only when the applicant is approved and workflow requirements are complete.
   - Transfer creates the official Employee Directory record.
   - Optional employee code can be entered; otherwise the system uses generated rules.

8. Create Level 1 employee account:
   - Available only after transfer.
   - Creates a Regular Employee account.
   - The HR Manager cannot choose a higher role in this flow.
   - Temporary password is shown only once and must be delivered securely.

9. Audit trail and integrity ledger:
   - Shows workflow activity.
   - Shows chained integrity records and pending ledger anchors.

Presenter says:

"This workflow prevents silent privilege escalation. HR can create only a Level 1 Regular Employee account after an applicant has been approved and transferred. HR cannot use this flow to create an administrator, payroll manager, or payroll officer account."

Position Routing tab:

Screen action:

1. Click `Position Routing`.
2. Show the routing rule form.
3. Demonstrate save, edit, and delete using sample data only.

Presenter says:

"Position-based routing controls whether a job title requires screening and training or can proceed directly to HR approval. This keeps onboarding consistent instead of relying on memory or manual decisions."

Position routing functions:

- Add route rule.
- Select department or allow any department.
- Toggle screening required.
- Toggle training required.
- Save rule.
- Edit rule.
- Delete rule.

## 7. Employee Profile and 201-File Management

Screen action:

1. Go back to `Employees`.
2. Click an employee row.
3. Show the profile summary.
4. Show each profile tab.
5. Click `Edit Profile`, then show editable fields.

Presenter says:

"After transfer or direct registration, the employee is managed in the official Employee Directory. The profile contains the employee's HR 201-file information, employment information, family, education, training, work experience, documents, compensation references, and leave history."

Profile tabs and functions:

- Personal Info:
  - View and edit name, suffix, nationality, birth details, gender, civil status, blood type, and religion.

- Contact Info:
  - View and edit email, work email, phone, home address, current address, mailing address, and emergency contact.

- Employment Info:
  - View and edit department, position, employment type, hiring type, status, date hired, end of contract, agency deployment, supervisor, work location, shift schedule, employee level, and employment history.

- Family:
  - Add family information.
  - Search family table.
  - Delete family record.

- Education/Training:
  - Record junior high school, senior high school, vocational/technical, and college details.
  - Add certification.
  - Add training.
  - Delete certification or training record.

- Work Experience:
  - Add previous work experience.
  - Search work experience table.
  - Delete work experience record.

- Documents:
  - Upload employee document.
  - View/open document.
  - Maintain prepared 201-file documents.

- Compensation:
  - View salary configuration, allowances, payroll schedule, bank account, and government numbers.
  - Note: some payroll-sensitive fields may be restricted depending on role.

- Leave History:
  - View employee leave records and used leave days.

Photo functions:

- Upload employee photo from profile.
- Update sidebar and directory avatar after upload.

Security point:

"This profile page demonstrates controlled access to the employee 201-file. HR can manage HR records, while payroll-sensitive and system administration actions remain separated by role."

## 8. Attendance Management Module

Screen action:

1. Click `Attendance`.
2. Show the overview.
3. Open each tab: Attendance Records, Overtime, Attendance Exceptions, Biometrics, Attendance Policies, Audit Log.

Presenter says:

"Attendance Management supports biometric attendance, HR validation, corrections, overtime encoding, device diagnostics, policy configuration, and audit logging. Attendance records become payroll-ready only after proper validation."

Overview functions:

- Present count.
- Late count.
- On leave count.
- Absent count.
- Verified regular hours.
- Approved overtime hours.

Attendance Records functions:

- Search employee.
- Filter by department.
- Filter by date from and date to.
- Filter by attendance status.
- Filter by validation status.
- Filter by payroll-ready status.
- View attendance details.
- Validate a record.
- Reject a record.
- Correct a record with required reason.
- Bulk validate selected records.
- Bulk reject selected records.
- Bulk correct selected records.
- Export attendance records.
- Add manual attendance.

Presenter says:

"Manual attendance is used only for verified biometric downtime or incomplete punches. Corrections require a reason and are recorded in the audit trail."

Overtime functions:

- Select employee.
- Select date.
- Enter approved overtime hours.
- Enter reason or reference.
- Save overtime.

Attendance Exceptions functions:

- Review missing time out.
- Review duplicate scans.
- Review forgotten scans.
- Review rejected attendance.
- Review HR corrections.
- Refresh exceptions.

Biometrics functions:

- Run biometric diagnostics.
- Check local ZK9500 bridge.
- Check HRIS device registration.
- Check fingerprint mappings.
- Check latest scan.
- Use local ZK9500 when available.
- Refresh scanner status.
- Select employee for fingerprint enrollment.
- Enroll fingerprint.
- Verify fingerprint.
- Remove fingerprint.
- Monitor recent fingerprint attendance activity.

Attendance Policies functions:

- Save policy version by effective date.
- Schedule policies:
  - Work start and end time.
  - Break start and end time.
  - Required daily working hours.

- Validation policies:
  - Grace period.
  - Late tracking.
  - Late threshold.
  - Count late for payroll.
  - Undertime tracking.
  - Count undertime for payroll.
  - Half-day rule.
  - HR validation requirement.
  - Auto payroll ready.
  - Validation expiration.
  - Missing timeout handling.

- Overtime policies:
  - Enable overtime.
  - Overtime threshold.
  - Overtime approval requirement.
  - Minimum overtime minutes.

- Payroll policies:
  - Payroll attendance source.
  - Working days per month.
  - Late deduction method and fixed amount.
  - Grace period application.
  - Late approval requirement.
  - Undertime deduction method and fixed amount.
  - Undertime approval requirement.

- Biometric policies:
  - Duplicate scan window.

- Holiday policies:
  - Enable holiday rules.
  - Regular holiday multiplier.
  - Special holiday multiplier.
  - Rest day multiplier.
  - Holiday overtime multiplier.
  - Allow manual attendance.
  - Allow HR correction.
  - Allow manager certification.
  - Device failure handling.

Audit Log functions:

- Review timestamp.
- Review performed by.
- Review employee.
- Review action.
- Review old and new values.
- Review IP.
- Refresh audit log.

Security point:

"Attendance validation and correction are not silent edits. Each correction requires a reason and is recorded for accountability."

## 9. Leave Management Module

Screen action:

1. Click `Leave Management`.
2. Show the Overview.
3. Walk through Manual Encoding, Requests, Balances, Leave Types, Calendar, and Audit & Reports.

Presenter says:

"Leave Management allows HR to monitor leave balances, encode manual leave when appropriate, approve or reject requests, configure leave policies, view leave calendars, and generate leave reports."

Overview functions:

- Pending requests.
- Approved requests.
- Rejected requests.
- Employees on leave today.
- Total requests this month.
- Leave balances.
- View another employee's leave balance when HR access is available.

Manual Encoding functions:

- Expand form.
- Select employee.
- Auto-fill pay type and department.
- Select leave type.
- Select start date and end date.
- Calculate duration.
- Attach supporting file.
- Enter reason.
- Enter remarks.
- Save manual leave.
- Clear form.

Presenter says:

"Manual leave encoding is useful for employees or situations where HR must record a verified leave entry directly, such as per-piece or per-trip employees or non-portal filing."

Requests functions:

- Search employee.
- Filter by department.
- Filter by pay type.
- Filter by leave type.
- Filter by status.
- Filter by source: Portal or Manual.
- Filter by date range.
- View leave details.
- Approve pending leave.
- Reject pending leave with remarks.
- Cancel approved leave when needed.
- Paginate request results.

Balances functions:

- Select employee.
- Select leave type.
- Select year.
- Configure total days.
- Configure used days.
- Preview remaining days.
- Save balance.
- Edit balance.
- Clear balance form.

Leave Types functions:

- Create or edit leave type.
- Select leave name.
- Set category: Company or Statutory.
- Set maximum allowed days.
- Set paid or unpaid status.
- Set active or inactive.
- Require attachment.
- Allow unpaid extension.
- Set maximum extension days.
- Add description.
- Configure eligibility:
  - Female only.
  - Male only.
  - Married only.
  - Solo parent required.
  - Medical certificate required.
  - Legal document required.
  - Minimum service months.

Calendar functions:

- Filter by department.
- Filter by status.
- Navigate previous and next month.
- Review leave entries by date.

Audit and Reports functions:

- Review leave audit trail.
- Export summary as CSV, Excel, or PDF.
- Export leave balance report.
- Export monthly leave report.

Security point:

"Leave approval is role-controlled, and approval, rejection, cancellation, balance changes, and manual encoding should be traceable in audit logs."

## 10. Reports Module

Screen action:

1. Click `Reports`.
2. Show Date From, Date To, and Payroll Period filters.
3. Show Available Outputs.
4. Open Generate or Print for each report type without necessarily downloading real files.

Presenter says:

"The Reports module provides HR-accessible operational outputs. The available outputs in this build are Attendance DTR, Payroll Registry, and Payslip generation. Some reports require a specific employee or payroll period before generation."

Report filters:

- Date From.
- Date To.
- Payroll Period.
- Reset Filters.

Available outputs:

1. Attendance DTR:
   - Daily time record.
   - Requires one selected employee.
   - Includes time in, time out, hours, late, undertime, and payroll-ready status.
   - Output format: PDF.

2. Payroll Registry:
   - Production payroll registry.
   - Requires a monthly payroll period.
   - Registry types:
     - Main Sewing Registry.
     - 55% Sewing Registry.
     - 45% Sewing Registry.
     - SWR-FXR-SUM Registry.
   - Output format: PDF.

3. Employee Payslip:
   - Requires one employee and one payroll period.
   - Output format: PDF.

Report actions:

- Generate.
- Print or preview.
- Select department.
- Select employee.
- Select payroll period.
- Select registry type when generating payroll registry.

Important RBAC note:

"The HR Manager may access operational reports made available to HR. However, the official financial summary report and final payroll approval remain Payroll Manager responsibilities. This separation protects payroll integrity and supports the capstone requirement for strict role-based access control."

## 11. Employee Lifecycle Demonstration - Full Story

Use this as the main narrative thread for the capstone demo.

### Stage 1 - Prepare Organization Data

Screen action:

1. Go to `Organization Setup`.
2. Confirm department exists.
3. Confirm position exists.
4. Confirm employee ID generation.

Presenter says:

"The lifecycle starts before an employee is created. HR first prepares departments, positions, and employee ID rules. This makes employee records standardized and avoids inconsistent job titles."

### Stage 2 - Intake a New Employee or Applicant

Screen action:

1. Go to `Employees`.
2. Click `Add Employee`.
3. Fill sample personal, contact, and employment details.
4. Choose a department and position.
5. Select an onboarding decision.

Presenter says:

"During intake, HR collects the required personal, contact, employment, compensation, government, bank, and document details. The system can either create the employee directly as active or route the record to onboarding."

Recommended demo choice:

- Use `Needs screening / requirements check` or `Needs training`.
- Add a short HR note.
- Save the record.

Presenter says:

"For this demonstration, I will route the record to onboarding so we can show the screening, training, approval, and transfer workflow."

### Stage 3 - Review Applicant in On-Boarding

Screen action:

1. Go to `On-Boarding`.
2. Find the routed applicant.
3. Click `Review`.

Presenter says:

"The applicant is now outside the official Employee Directory until HR completes the required process. This prevents incomplete records from immediately becoming active employee records."

### Stage 4 - Complete Requirements, Screening, and Training

Screen action:

1. Upload a sample prepared document if available.
2. Verify the document.
3. Set screening to `Passed Screening` if required.
4. Set training to `Completed Training` if required.
5. Click `Save Progress`.

Presenter says:

"HR records requirements checking, screening, and training progress. Documents are prepared for the 201-file, and each action is visible in the onboarding audit trail."

### Stage 5 - HR Decision

Screen action:

1. Set HR approval decision to `Approved`.
2. Click `Record Decision`.

Presenter says:

"Only the HR Manager role can record the final HR decision in this workflow. The system checks that required screening and training steps are complete before approval."

### Stage 6 - Transfer to Employee Directory

Screen action:

1. In the approved applicant review screen, click `Transfer to Employee Directory`.
2. Leave employee code blank to auto-generate or enter a sample code.
3. Confirm transfer.

Presenter says:

"Once approved, the applicant is transferred into the official Employee Directory. Prepared documents, wage references, and biometric references are carried forward when available."

### Stage 7 - Create Regular Employee Account

Screen action:

1. After transfer, click `Create Level 1 Account`.
2. Enter optional username or let the system generate one.
3. Enter optional temporary password or let the system generate one.
4. Click `Create Account`.

Presenter says:

"The HR Manager can create a Regular Employee Level 1 account only after the applicant is approved and transferred. The role is fixed to Regular Employee in this flow. HR cannot grant admin or payroll authority here."

Security point:

"The temporary password should be delivered through an approved secure channel and must not be displayed publicly during the demo."

### Stage 8 - Manage Active Employee

Screen action:

1. Return to `Employees`.
2. Search for the employee.
3. Open the profile.
4. Show profile tabs and documents.

Presenter says:

"The employee is now part of the official workforce directory. HR can maintain profile details, 201-file documents, family records, education, training, work experience, and leave history."

### Stage 9 - Enroll or Validate Attendance

Screen action:

1. Go to `Attendance`.
2. Show biometrics tab.
3. Show attendance records.
4. Validate or correct a sample attendance record.

Presenter says:

"After employment, attendance is captured through biometric integration. HR validates records before they are treated as payroll-ready. Any correction requires a reason and is recorded in the audit log."

### Stage 10 - Manage Leave

Screen action:

1. Go to `Leave Management`.
2. Show leave balances.
3. Open Requests.
4. Approve or reject a sample pending request.
5. Show Calendar.

Presenter says:

"Employees may file leave requests, and HR can review, approve, reject, or manually encode leave records. Balances, policies, calendar view, and audit reports support accurate HR tracking."

### Stage 11 - Generate Reports

Screen action:

1. Go to `Reports`.
2. Generate or preview an Attendance DTR using a selected employee.
3. Show Payroll Registry and Payslip options without claiming payroll final approval.

Presenter says:

"HR can generate allowed operational reports such as attendance DTRs and available payroll-related outputs. Final payroll approval and official financial summary exports remain outside HR Manager authority."

### Stage 12 - Offboarding

Screen action:

1. Go to `Employees`.
2. Choose a sample active employee only.
3. Open action menu.
4. Click `Offboard Employee`.
5. Walk through the offboarding wizard but avoid submitting unless using safe demo data.

Presenter says:

"Offboarding is handled through a controlled wizard. HR records the offboarding type, effective date, last working day, reason, clearance status, account action, clearance checklist, payroll clearance placeholders, IT access revocation placeholders, and process tracking."

Offboarding functions:

- Employee information review.
- Offboarding type.
- Effective date.
- Last working day.
- Reason.
- Clearance status.
- Account action.
- Company property status.
- Turnover status.
- Exit interview status.
- Attendance and leave clearance.
- Payroll clearance tracking.
- IT access revocation tracking.
- Offboarding status.
- Submit audited offboarding request.

Security point:

"Offboarding may disable accounts and revoke access, so this should be demonstrated only on test employees."

### Stage 13 - Re-onboarding

Screen action:

1. Use a sample separated employee with status such as Resigned, Terminated, End of Contract, Retired, or Offboarded.
2. Open action menu.
3. Click `Re-onboard Employee`.
4. Walk through the re-onboarding wizard.

Presenter says:

"Re-onboarding supports returning workers. HR can review previous employee details, set rehire date, assign a new position or department, update work location, employment type, hiring type, supervisor, employee level, payroll setup status, system role, password reset requirement, and remarks."

Re-onboarding functions:

- Previous employee information review.
- Rehire date.
- New position.
- Department.
- Work location.
- Employment type.
- Hiring type.
- New supervisor.
- Employee level.
- Payroll setup status.
- Assigned system role.
- Force password reset.
- Account reactivation note.
- Remarks.
- Submit re-onboarding request.

Security warning for the demo:

"If showing re-onboarding, use a test employee and do not assign higher roles casually. Role assignment should follow the approved RBAC process."

## 12. Short Closing Script

Presenter says:

"This completes the HR Manager demonstration. We showed the dashboard, organization setup, employee management, onboarding, attendance management, leave management, reports, and the full employee lifecycle from intake to onboarding, active employment, attendance and leave processing, reporting, offboarding, and re-onboarding."

"The important security design is that every major HR action is authenticated, role-controlled, validated, and auditable. HR Manager can manage HR lifecycle processes, but cannot bypass payroll final approval, cannot manage system-wide RBAC, and cannot create privileged accounts through the employee account creation flow."

"This supports the capstone goal of improving HR and payroll accuracy while protecting sensitive employee, attendance, and payroll data through secure-by-design and zero trust principles."

## Quick Demo Checklist

Use this checklist before the live demo:

- Confirm HR Manager account can log in.
- Confirm MFA flow, if enabled.
- Prepare one safe sample employee or applicant.
- Confirm at least one department and position exist.
- Prepare one pending onboarding applicant or route a sample record during demo.
- Prepare one sample attendance record for validation.
- Prepare one pending leave request if possible.
- Prepare one safe sample document for upload.
- Avoid offboarding real admin, payroll, or presenter accounts.
- Do not show passwords, MFA codes, JWTs, database credentials, or raw SQL errors.
- Do not claim HR Manager can approve final payroll or export official financial summaries.

