UPDATE salary_calculations
   SET status = 'Approved'
 WHERE status IN ('Finalized','Paid','Released');

UPDATE salary_calculations
   SET status = 'Submitted'
 WHERE status IN ('Superseded','Cancelled') OR status = '';

ALTER TABLE salary_calculations
  MODIFY COLUMN status ENUM('Draft','Submitted','Approved') DEFAULT 'Submitted';
