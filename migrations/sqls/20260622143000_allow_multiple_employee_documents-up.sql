CREATE INDEX idx_documents_employee_type_uploaded
  ON documents (employee_id, document_type, uploaded_date);

ALTER TABLE documents DROP INDEX unique_doc_per_emp;
