DELETE d1
FROM documents d1
JOIN documents d2
  ON d1.employee_id = d2.employee_id
 AND d1.document_type = d2.document_type
 AND d1.id < d2.id;

ALTER TABLE documents ADD UNIQUE KEY unique_doc_per_emp (employee_id, document_type);

ALTER TABLE documents DROP INDEX idx_documents_employee_type_uploaded;
