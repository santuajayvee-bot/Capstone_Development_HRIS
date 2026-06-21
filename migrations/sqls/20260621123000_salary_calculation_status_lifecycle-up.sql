ALTER TABLE salary_calculations
  MODIFY COLUMN status ENUM('Draft','Submitted','Approved','Finalized','Paid','Released','Superseded','Cancelled') DEFAULT 'Submitted';

UPDATE salary_calculations
   SET status = 'Submitted'
 WHERE status = '';
