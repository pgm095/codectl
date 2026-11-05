; Definitions and references for JavaScript.
; Differs from typescript.scm: no interfaces/enums/type aliases, and class_declaration
; names with (identifier) instead of (type_identifier).

; --- definitions ---

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(class_declaration
  name: (identifier) @name) @definition.class

(variable_declarator
  name: (identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function

; --- references ---

(call_expression
  function: (identifier) @name) @reference.call

(call_expression
  function: (member_expression
    property: (property_identifier) @name)) @reference.call

(new_expression
  constructor: (identifier) @name) @reference.class

(class_heritage
  (identifier) @name) @reference.class

(import_statement
  source: (string (string_fragment) @name)) @reference.import
