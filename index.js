require("dotenv").config();
const axios = require("axios");
const env = {
  tableId: process.env.BOTPRESS_TABLE_ID,
  botpressKey: process.env.BOTPRESS_PAT,
  webflowKey: process.env.WEBFLOW_TOKEN,
  webflowCollectionId: process.env.WEBFLOW_CMS_COLLECTION_ID,
};
const event = {
  botId: process.env.BOTPRESS_BOT_ID,
};
const main = async () => {
  // start botpress code
  // define variables from environment variables
  const webflowKey = env.webflowKey;
  const tableId = env.tableId;
  const botpressKey = env.botpressKey;
  const webflowCollectionId = env.webflowCollectionId;
  const botId = event.botId;

  // define functions

  const setRows = async (rows) => {
    const response = await axios.put(
      `https://api.botpress.cloud/v1/tables/${tableId}/rows`,
      {
        rows, // [{id, bpIntegrationId, webflowItemId,bpUpdatedAt,bpCreatedAt,needsSync}]
      },
      {
        headers: {
          Authorization: `Bearer ${botpressKey}`,
          "x-bot-id": botId,
        },
      }
    );
    return response.data;
  };

  const getAllIntegrations = async () => {
    // we fetch integrations using the /integrations endpoint and keep getting next pages for anything that has been updated after lastSync
    // then we call each integration, and also call it's readme url to fetch it
    // then we return everything
    let nextToken = undefined;
    let integrations = [];
    do {
      const integrationListUrl = nextToken
        ? `https://api.botpress.cloud/v1/admin/hub/integrations?version=latest&nextToken=${nextToken}`
        : `https://api.botpress.cloud/v1/admin/hub/integrations?version=latest`;
      const response = await axios.get(integrationListUrl, {
        headers: {
          Authorization: `Bearer ${botpressKey}`,
          "x-bot-id": botId,
        },
      });
      nextToken = response.data.meta?.nextToken;

      integrations.push(...response.data.integrations);
    } while (nextToken);

    return integrations;
  };

  const updateOrCreateWebflowCmsItem = async (integration) => {
    // first let's fetch the integration, and the readme
    const integrationResponse = await axios.get(
      `https://api.botpress.cloud/v1/admin/hub/integrations/${integration.bpIntegrationId}`,
      {
        headers: {
          Authorization: `Bearer ${botpressKey}`,
          "x-bot-id": botId,
        },
      }
    );
    const integrationWithReadme = {
      ...integrationResponse.data.integration,
      readme: await axios
        .get(integrationResponse.data.integration.readmeUrl)
        .then((res) => res.data),
    };

    const itemPayload = {
      isArchived: false,
      isDraft: false,
      fieldData: {
        // must be lowercase
        name: integrationWithReadme.name,
        slug: integrationWithReadme.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/-$/, "")
          .replace(/^-/, ""),
        description: integrationWithReadme.description,
        readme: integrationWithReadme.readme,
        updatedat: integrationWithReadme.updatedAt,
        createdat: integrationWithReadme.createdAt,
        iconurl: integrationWithReadme.iconUrl,
        integrationid: integrationWithReadme.id,
        version: integrationWithReadme.version,
        workspaceownerid: integrationWithReadme.ownerWorkspace.id,
        workspaceownername: integrationWithReadme.ownerWorkspace.name,
        workspaceownerhandle: integrationWithReadme.ownerWorkspace.handle,
        title: integrationWithReadme.title,
      },
    };

    // if the integration has a webflowItemId, we update the item
    // if it doesn't, we create the item

    if (integration.webflowItemId) {
      // update
      const response = await axios.patch(
        `https://api.webflow.com/v2/collections/${webflowCollectionId}/items/${integration.webflowItemId}`,
        itemPayload,
        {
          headers: {
            Authorization: `Bearer ${webflowKey}`,
          },
        }
      );

      // set the needsSync to false
      await setRows([
        {
          ...integration,
          needsSync: false,
        },
      ]);
      console.log(
        `updated item bpIntegrationId: ${integration.bpIntegrationId} webflowItemId: ${integration.webflowItemId}`
      );
    } else {
      // create
      const response = await axios.post(
        `https://api.webflow.com/v2/collections/${webflowCollectionId}/items`,
        itemPayload,
        {
          headers: {
            Authorization: `Bearer ${webflowKey}`,
          },
        }
      );

      // set the webflowItemId in the table and set needsSync to false
      await setRows([
        {
          ...integration,
          webflowItemId: response.data.id,
          needsSync: false,
        },
      ]);
      console.log(
        `created item bpIntegrationId: ${integration.bpIntegrationId} webflowItemId: ${response.data.id}`
      );
    }
  };

  const createOrUpdateIntegrations = async (integrations) => {
    // first let's convert them to the right format
    const rows = integrations.map((integration) => {
      return {
        bpIntegrationId: integration.id,
        bpUpdatedAt: integration.updatedAt,
        bpCreatedAt: integration.createdAt,
      };
    });
    // now for each, let's check if it exists in the table
    // if it does, we will update the row
    // if it doesn't, we will create the row

    await Promise.all(
      rows.map(async (row) => {
        const response = await axios.post(
          `https://api.botpress.cloud/v1/tables/${tableId}/rows/find`,
          {
            filter: { bpIntegrationId: { $eq: row.bpIntegrationId } },
          },
          {
            headers: {
              Authorization: `Bearer ${botpressKey}`,
              "x-bot-id": botId,
            },
          }
        );
        const tableRow = response.data.rows[0];

        if (!tableRow) {
          await axios.post(
            `https://api.botpress.cloud/v1/tables/${tableId}/rows`,
            { rows: [{ ...row, needsSync: true }] },
            {
              headers: {
                Authorization: `Bearer ${botpressKey}`,
                "x-bot-id": botId,
              },
            }
          );
        } else {
          // check if needs sync
          if (tableRow.needsSync) {
            return; // nothing to do, already needs sync
          }
          // if the row's updated at differs from the tables bpUpdatedAt, we need to update

          if (tableRow.bpUpdatedAt !== row.bpUpdatedAt) {
            await axios.put(
              `https://api.botpress.cloud/v1/tables/${tableId}/rows`,
              {
                rows: [
                  {
                    ...row,
                    needsSync: true,
                    id: tableRow.id,
                  },
                ],
              },
              {
                headers: {
                  Authorization: `Bearer ${botpressKey}`,
                  "x-bot-id": botId,
                },
              }
            );
          }
        }
      })
    );
  };

  const updateIntegrationsInCms = async () => {
    // get all integrations in db using filter, remember to use pagination

    let integrations = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const response = await axios.post(
        `https://api.botpress.cloud/v1/tables/${tableId}/rows/find`,
        {
          filter: { needsSync: { $eq: true } },
          offset,
          limit,
        },
        {
          headers: {
            Authorization: `Bearer ${botpressKey}`,
            "x-bot-id": botId,
          },
        }
      );

      integrations.push(...response.data.rows);

      offset += limit;
      const { hasMore } = response.data;

      if (!hasMore) {
        break;
      }
    }

    await Promise.all(
      integrations.map(async (integration) => {
        try {
          await updateOrCreateWebflowCmsItem(integration);
        } catch (error) {
          console.log("🚀 ~ integrations.map ~ error:", error);
        }
      })
    );
  };

  const syncBotpressSide = async () => {
    const integrations = await getAllIntegrations();
    

    await createOrUpdateIntegrations(integrations);
  };

  console.log("started sync");
  const start = new Date();
  await syncBotpressSide();
  const afterBotpressSync = new Date();
  console.log("botpress sync took", afterBotpressSync - start, "ms");
  await updateIntegrationsInCms();
  const end = new Date();
  console.log("webflow sync took", end - afterBotpressSync, "ms");
  console.log("finished sync");
  // end botpress code
};
main();
