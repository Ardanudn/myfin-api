import { prisma } from '../config/prisma.js';
import APIError from '../errorHandling/apiError.js';
import * as cryptoUtils from '../utils/CryptoUtils.js';
import SessionManager from '../utils/sessionManager.js';
import { Prisma } from '@prisma/client';
import CategoryService from './categoryService.js';
import EntityService from './entityService.js';
import DemoDataManager from '../utils/demoDataManager.js';
import AccountService from './accountService.js';
import Logger from '../utils/Logger.js';
import ConvertUtils from '../utils/convertUtils.js';
import TagService from './tagService.js';

const User = prisma.users;

interface CategoriesEntitiesTagsOutput {
  categories?: Array<{ category_id: bigint; name: string; type: string }>;
  entities?: Array<{ entity_id: bigint; name: string }>;
  tags?: Array<{ tag_id: bigint; name: string; description?: string }>;
}

const userService = {
  createUser: async (user: Prisma.usersCreateInput) => {
    // eslint-disable-next-line no-param-reassign
    user.password = cryptoUtils.hashPassword(user.password);
    return User.create({ data: user });
  },
  attemptLogin: async (username: string, password: string, mobile: boolean, dbClient = prisma) => {
    const whereCondition = { username };
    const data = await User.findUniqueOrThrow({
      where: whereCondition,
    }).catch(() => {
      throw APIError.notAuthorized('User Not Found');
    });
    let userAccounts = [];
    if (data) {
      const isValid = cryptoUtils.verifyPassword(password, data.password);
      if (isValid) {
        const newSessionData = await SessionManager.generateNewSessionKeyForUser(username, mobile);
        if (mobile) {
          // eslint-disable-next-line no-param-reassign
          data.sessionkey_mobile = newSessionData.sessionkey;
          // eslint-disable-next-line no-param-reassign
          data.trustlimit_mobile = newSessionData.trustlimit;
        } else {
          // eslint-disable-next-line no-param-reassign
          data.sessionkey = newSessionData.sessionkey;
          // eslint-disable-next-line no-param-reassign
          data.trustlimit = newSessionData.trustlimit;
        }

        userAccounts = await AccountService.getAccountsForUser(data.user_id, undefined, dbClient);
        Logger.addStringifiedLog(userAccounts);
      } else {
        throw APIError.notAuthorized('Wrong Credentials');
      }
    } else {
      throw APIError.notAuthorized('User Not Found');
    }

    return {
      user_id: data.user_id,
      username: data.username,
      email: data.email,
      sessionkey: data.sessionkey,
      sessionkey_mobile: data.sessionkey_mobile,
      last_update_timestamp: data.last_update_timestamp,
      accounts: userAccounts.map((account) => {
        return {
          ...account,
          balance: ConvertUtils.convertBigIntegerToFloat(account.current_balance ?? 0),
        };
      }),
    };
  },
  getUserIdFromUsername: async (username: string): Promise<bigint> => {
    const whereCondition = { username };
    const selectCondition: Prisma.usersSelect = {
      user_id: true,
    } satisfies Prisma.usersSelect;

    /* type UserPayload = Prisma.usersGetPayload<{select: typeof selectCondition}> */

    const user = await User.findUnique({
      where: whereCondition,
      select: selectCondition,
    });
    return (user as { user_id: bigint }).user_id;
  },
  setupLastUpdateTimestamp: async (userId, timestamp, prismaClient = prisma) => {
    return prismaClient.users.update({
      where: { user_id: userId },
      data: { last_update_timestamp: timestamp },
    });
  },
  changeUserPassword: async (
    userId: bigint,
    currentPassword: string,
    newPassword: string,
    mobile: boolean,
    dbClient = prisma
  ) => {
    /* Check if current password is valid */
    const whereCondition = { user_id: userId };
    const data: Prisma.usersUpdateInput = await User.findUniqueOrThrow({
      where: whereCondition,
    }).catch(() => {
      throw APIError.notAuthorized('User Not Found');
    });

    const isValid = cryptoUtils.verifyPassword(currentPassword, data.password);
    if (!isValid) {
      throw APIError.notAuthorized('Wrong credentials');
    }

    /* Change the password */
    const hashedPassword = cryptoUtils.hashPassword(newPassword);
    await dbClient.users.update({
      where: { user_id: userId },
      data: { password: hashedPassword },
    });

    await SessionManager.generateNewSessionKeyForUser(data.username as string, mobile);
  },
  getFirstUserTransactionDate: async (
    userId: bigint,
    dbClient = prisma
  ): Promise<
    | {
        date_timestamp: number;
        month: number;
        year: number;
      }
    | undefined
  > => {
    const data = await dbClient.$queryRaw`SELECT date_timestamp,
                                                     MONTH(FROM_UNIXTIME(date_timestamp)) as 'month',
                                                     YEAR(FROM_UNIXTIME(date_timestamp))  as 'year',
                                                     entities.users_user_id
                                              FROM transactions
                                                       left join entities ON entities_entity_id = entities.entity_id
                                              WHERE users_user_id = ${userId}
                                              ORDER BY date_timestamp ASC
                                              LIMIT 1`;
    if (Array.isArray(data)) {
      return data[0];
    } else return undefined;
  },
  getUserCategoriesEntitiesTags: async (
    userId: bigint,
    dbClient = prisma
  ): Promise<CategoriesEntitiesTagsOutput> => {
    const categories = await CategoryService.getAllCategoriesForUser(
      userId,
      {
        category_id: true,
        name: true,
        type: true,
      },
      dbClient
    );

    const entities = await EntityService.getAllEntitiesForUser(
      userId,
      {
        entity_id: true,
        name: true,
      },
      dbClient
    );

    const tags = await TagService.getAllTagsForUser(
      userId,
      {
        tag_id: true,
        name: true,
        description: true,
      },
      dbClient
    );

    return {
      categories: categories.map((cat) => {
        return {
          category_id: cat.category_id as bigint,
          name: cat.name as string,
          type: cat.type as string,
        };
      }),
      entities: entities.map((ent) => {
        return { entity_id: ent.entity_id as bigint, name: ent.name as string };
      }),
      tags: tags.map((tag) => {
        return {
          tag_id: tag.tag_id as bigint,
          name: tag.name as string,
          description: tag.description as string,
        };
      }),
    };
  },
  autoPopulateDemoData: async (userId: bigint, dbClient = undefined) =>
    DemoDataManager.createMockData(userId, dbClient),
};
export default userService;
