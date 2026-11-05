; Definitions and references for TypeScript.
; Convention: @definition.<kind> and @reference.<kind>, with @name on the identifier.
; tsx.scm and javascript.scm derive from this file; see lib/extract.py (QUERY_FALLBACK).

; --- definitions ---

(function_declaration
  name: (identifier) @name) @definition.function

(generator_function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

; const foo = () => {}  /  const foo = function () {}
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

(extends_clause
  value: (identifier) @name) @reference.class

(import_statement
  source: (string (string_fragment) @name)) @reference.import
