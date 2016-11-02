/**
 * @fileoverview Rule to flag Mocha tests marked as "only"
 * @author Luke Albao
 */

'use strict';

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

module.exports = {
  meta: {
    docs: {
      description: 'Disallow committing code with skipped mocha tests',
      category: 'Possible Errors'
    },
    schema: [
      {
        type: 'object',
        properties: {
          allow: {
            type: 'array',
            items: {
              type: 'string'
            },
            minItems: 1,
            uniqueItems: true
          }
        },
        additionalProperties: false
      }
    ],
    fixable: true
  },
  create: function (context) {
    return {
      MemberExpression: function (node) {
        if ((node.object.name === 'describe' &&  node.property.name === 'only')
          || (node.object.name === 'it' &&  node.property.name === 'only')){
          context.report({
            node: node,
            message: 'All tests must run',
            fix: function (fixer) {
              return fixer.removeRange([node.property.start - 1,
                                        node.property.end]);
            }
          });
        }
      }
    };
  }
};
