; Definitions and references for Python.
; Convention: @definition.<kind> and @reference.<kind>, with @name on the identifier.

; --- definitions ---

(function_definition
  name: (identifier) @name) @definition.function

(class_definition
  name: (identifier) @name) @definition.class

; --- references ---

(call
  function: (identifier) @name) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name)) @reference.call

(class_definition
  superclasses: (argument_list (identifier) @name)) @reference.class

; The whole dotted_name, not each loose identifier: "a.b", not "a" and "b".
(import_statement
  name: (dotted_name) @name) @reference.import

(import_from_statement
  module_name: (dotted_name) @name) @reference.import
