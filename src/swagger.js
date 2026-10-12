/**
 * OpenAPI 3.0 specification for the Trip Tracker API.
 * Served via swagger-ui-express at `/api-docs`.
 */
const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Trip Tracker API',
    version: '1.0.0',
    description:
      'REST API for a tourist group trip application: authentication (Better Auth), ' +
      'trip groups, live chat, and expense tracking.',
  },
  servers: [
    { url: 'http://localhost:5000', description: 'Local development' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'better-auth.session_token',
        description: 'Session cookie set by /api/auth/signup or /api/auth/login.',
      },
    },
    schemas: {
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          emailVerified: { type: 'boolean' },
          image: { type: 'string', nullable: true },
          avatarUrl: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Group: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          invite_code: { type: 'string' },
          created_by: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Member: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string' },
          role: { type: 'string', enum: ['admin', 'member'] },
          joined_at: { type: 'string', format: 'date-time' },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          group_id: { type: 'integer' },
          user_id: { type: 'string' },
          message: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Expense: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          group_id: { type: 'integer' },
          paid_by: { type: 'string' },
          amount: { type: 'number' },
          description: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
      },
    },
  },
  tags: [
    { name: 'Auth', description: 'Sign up, sign in, sign out, and current user' },
    { name: 'Groups', description: 'Trip groups, invite codes, and members' },
    { name: 'Chat', description: 'Group chat messages' },
    { name: 'Expenses', description: 'Trip expenses and balances' },
  ],
  paths: {
    '/api/auth/signup': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'email', 'password'],
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 6 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'User created and session cookie set',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string' },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          400: { description: 'Missing or invalid fields', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with email and password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Session cookie set',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    redirect: { type: 'boolean' },
                    token: { type: 'string' },
                    user: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'End the current session',
        responses: {
          200: {
            description: 'Signed out',
            content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } },
          },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Return the current authenticated user',
        security: [{ cookieAuth: [] }],
        responses: {
          200: {
            description: 'Current user',
            content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } } } },
          },
          401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/groups/create': {
      post: {
        tags: ['Groups'],
        summary: 'Create a new trip group (generates a unique invite code)',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
            },
          },
        },
        responses: {
          201: {
            description: 'Group created; creator added as admin',
            content: { 'application/json': { schema: { type: 'object', properties: { group: { $ref: '#/components/schemas/Group' } } } } },
          },
          400: { description: 'Group name required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/groups/join': {
      post: {
        tags: ['Groups'],
        summary: 'Join a group using an invite code',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['inviteCode'], properties: { inviteCode: { type: 'string' } } },
            },
          },
        },
        responses: {
          201: {
            description: 'Joined the group',
            content: { 'application/json': { schema: { type: 'object', properties: { group: { $ref: '#/components/schemas/Group' }, membership: { type: 'object' } } } } },
          },
          404: { description: 'Invalid invite code', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          409: { description: 'Already a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/groups': {
      get: {
        tags: ['Groups'],
        summary: 'List the current user\u2019s groups',
        security: [{ cookieAuth: [] }],
        responses: {
          200: {
            description: 'List of groups with the caller\u2019s role',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Group' } } } },
          },
        },
      },
    },
    '/api/groups/user/{userId}': {
      get: {
        tags: ['Groups'],
        summary: 'List all groups a specific user belongs to',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'List of groups with role',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Group' } } } },
          },
        },
      },
    },
    '/api/groups/{groupId}': {
      get: {
        tags: ['Groups'],
        summary: 'Get group details and its members',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Group with members',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    group: { $ref: '#/components/schemas/Group' },
                    members: { type: 'array', items: { $ref: '#/components/schemas/Member' } },
                  },
                },
              },
            },
          },
          403: { description: 'Not a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'Group not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/groups/{groupId}/members': {
      get: {
        tags: ['Groups'],
        summary: 'List all members of a group',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'List of members',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Member' } } } },
          },
          403: { description: 'Not a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Groups'],
        summary: 'Add a member to a group (admin only)',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  userId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Member added', content: { 'application/json': { schema: { type: 'object', properties: { member: { type: 'object' } } } } } },
          403: { description: 'Not an admin', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'User not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },

    '/api/chats/{groupId}': {
      get: {
        tags: ['Chat'],
        summary: 'Get message history for a group',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'List of messages',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } } } },
          },
        },
      },
    },

    '/api/expenses': {
      post: {
        tags: ['Expenses'],
        summary: 'Add an expense (payer is the authenticated user)',
        security: [{ cookieAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['groupId', 'amount'],
                properties: {
                  groupId: { type: 'integer' },
                  amount: { type: 'number', minimum: 0 },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Expense created',
            content: { 'application/json': { schema: { type: 'object', properties: { expense: { $ref: '#/components/schemas/Expense' } } } } },
          },
          400: { description: 'Invalid amount', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          403: { description: 'Not a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/expenses/{groupId}': {
      get: {
        tags: ['Expenses'],
        summary: 'List expenses in a group',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'List of expenses',
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Expense' } } } },
          },
        },
      },
    },
    '/api/expenses/summary/{groupId}': {
      get: {
        tags: ['Expenses'],
        summary: 'Total spend and per-member spent/owes',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Expense summary',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'number' },
                    members: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          userId: { type: 'string' },
                          name: { type: 'string' },
                          spent: { type: 'number' },
                          share: { type: 'number' },
                          owes: { type: 'number' },
                          receivable: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/expenses/{groupId}/balance': {
      get: {
        tags: ['Expenses'],
        summary: 'Equal-split balances and suggested settlements',
        security: [{ cookieAuth: [] }],
        parameters: [
          { name: 'groupId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          200: {
            description: 'Balances and who-owes-whom transfers',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'number' },
                    perPerson: { type: 'array', items: { type: 'object' } },
                    settlements: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          from: { type: 'string' },
                          fromName: { type: 'string' },
                          to: { type: 'string' },
                          toName: { type: 'string' },
                          amount: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

module.exports = swaggerDocument;
