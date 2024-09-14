import fs from "fs-extra";
import {
  Client,
  isFullUser,
  iteratePaginatedAPI,
} from "@notionhq/client";
import {
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";
import { NotionToMarkdown } from "./markdown/notion-to-md";
import YAML from "yaml";
import { sh } from "./sh";
import { DatabaseMount, PageMount } from "./config";
import { getPageTitle, getCoverLink, getDirectoryName } from "./helpers";
import { MdBlock } from "./markdown/types";
import path from "path";
import { getContentFile } from "./file";

function getExpiryTime(
  blocks: MdBlock[],
  expiry_time: string | undefined = undefined,
): string | undefined {
  for (const block of blocks) {
    if (block.expiry_time !== undefined) {
      if (expiry_time === undefined) expiry_time = block.expiry_time;
      else
        expiry_time =
          expiry_time < block.expiry_time ? expiry_time : block.expiry_time;
    }
    if (block.children.length > 0) {
      const child_expiry_time = getExpiryTime(block.children, expiry_time);
      if (child_expiry_time) {
        if (expiry_time === undefined) expiry_time = child_expiry_time;
        else
          expiry_time =
            expiry_time < child_expiry_time ? expiry_time : child_expiry_time;
      }
    }
  }
  return expiry_time;
}

export async function renderPage(page: PageObjectResponse, notion: Client) {
  // load formatter config
  const n2m = new NotionToMarkdown({ notionClient: notion });
  n2m.setUnsupportedTransformer((type) => {
    return `{{< notion-unsupported-block type=${type} >}}`;
  });
  let frontInjectString = "";
  let nearest_expiry_time: string | null = null;
  const mdblocks = await n2m.pageToMarkdown(page.id);
  const page_expiry_time = getExpiryTime(mdblocks);
  if (page_expiry_time) nearest_expiry_time = page_expiry_time;
  const mdString = n2m.toMarkdownString(mdblocks);
  page.properties.Name;
  const title = getPageTitle(page);
  const frontMatter: Record<
    string,
    string | string[] | number | boolean | PageObjectResponse
  > = {
    title,
    date: page.created_time,
    lastmod: page.last_edited_time,
    draft: false,
  };

  // set featuredImage
  const featuredImageLink = await getCoverLink(page.id, notion);
  if (featuredImageLink) {
    const { link, expiry_time } = featuredImageLink;
    frontMatter.featuredImage = link;
    // update nearest_expiry_time
    if (expiry_time) {
      if (nearest_expiry_time) {
        nearest_expiry_time =
          expiry_time < nearest_expiry_time ? expiry_time : nearest_expiry_time;
      } else {
        nearest_expiry_time = expiry_time;
      }
    }
  }

  // map page properties to front matter
  for (const property in page.properties) {
    const id = page.properties[property].id;
    const response = await notion.pages.properties.retrieve({
      page_id: page.id,
      property_id: id,
    });
    if (response.object === "property_item") {
      switch (response.type) {
        case "checkbox":
          frontMatter[property] = response.checkbox;
          break;
        case "select":
          if (response.select) frontMatter[property] = response.select.name;
          break;
        case "multi_select":
          frontMatter[property] = response.multi_select.map(
            (select) => select.name,
          );
          break;
        case "email":
          if (response.email) frontMatter[property] = response.email;
          break;
        case "url":
          if (response.url) frontMatter[property] = response.url;
          break;
        case "date":
          if (response.date) frontMatter[property] = response.date.start;
          break;
        case "number":
          if (response.number) frontMatter[property] = response.number;
          break;
        case "phone_number":
          if (response.phone_number)
            frontMatter[property] = response.phone_number;
          break;
        case "status":
          if (response.status) frontMatter[property] = response.status.name;
        // ignore these properties
        case "last_edited_by":
        case "last_edited_time":
        case "rollup":
        case "files":
        case "formula":
        case "created_by":
        case "created_time":
          break;
        default:
          break;
      }
    } else {
      for await (const result of iteratePaginatedAPI(
        // @ts-ignore
        notion.pages.properties.retrieve,
        {
          page_id: page.id,
          property_id: id,
        },
      )) {
        switch (result.type) {
          case "people":
            frontMatter[property] = frontMatter[property] || [];
            if (isFullUser(result.people)) {
              const fm = frontMatter[property];
              if (Array.isArray(fm) && result.people.name) {
                fm.push(result.people.name);
              }
            }
            break;
          case "rich_text":
            frontMatter[property] = frontMatter[property] || "";
            frontMatter[property] += result.rich_text.plain_text;
          // ignore these
          case "relation":
          case "title":
          default:
            break;
        }
      }
    }
  }

  // set default author
  if (frontMatter.authors == null) {
    try {
      const response = await notion.users.retrieve({
        user_id: page.last_edited_by.id,
      });
      if (response.name) {
        frontMatter.authors = [response.name];
      }
    } catch (error) {
      console.warn(`[Warning] Failed to get author name for ${page.id}`);
    }
  }

  // save metadata
  frontMatter.NOTION_METADATA = page;

  // save update time
  frontMatter.UPDATE_TIME = new Date().toISOString();
  // save nearest expiry time
  if (nearest_expiry_time) frontMatter.EXPIRY_TIME = nearest_expiry_time;

  return {
    title,
    pageString:
      "---\n" +
      YAML.stringify(frontMatter, {
        defaultStringType: "QUOTE_DOUBLE",
        defaultKeyType: "PLAIN",
      }) +
      "\n---\n" +
      frontInjectString +
      "\n" +
      mdString,
  };
}

export async function savePage(
  page: PageObjectResponse,
  notion: Client,
  mount: DatabaseMount | PageMount,
) {
  const postpath = path.join(
    "content",
    mount.target_folder,
    getDirectoryName(getPageTitle(page), page.id),
  );
  console.log(`Post path: ${postpath}`);
  // 确保路径安全
  const sanitizedPostPath = path.normalize(postpath).replace(/(^\.\.[\\\/]+|\/\.\.\/)/g, '');

  // 否则更新页面
  console.info(`[Info] Updating ${sanitizedPostPath}`);
  console.debug(`[Debug] Page: ${JSON.stringify(page)}`);

  try {
    const { title, pageString } = await renderPage(page, notion);
    const fileName = getDirectoryName(title, page.id);

    // 检查目录是否已存在
    const directoryPath = path.join("content", mount.target_folder, fileName);
    const directoryExists = await fs.access(directoryPath).then(() => true).catch(() => false);
    if (directoryExists) {
      // 删除目录
      await fs.rmdir(directoryPath, { recursive: true });
      console.info(`[Info] Directory exists and deleted: ${directoryPath}`);
    }

    // 创建目录
    await fs.mkdir(directoryPath, { recursive: true });
    console.info(`[Info] Directory created: ${directoryPath}`);

    // 在目录下创建 index.md 文件
    const indexPath = path.join(directoryPath, 'index.md');
    await fs.writeFile(indexPath, pageString);
    console.info(`[Info] File created: ${indexPath}`);

    // 使用异步命令创建新文件
    await sh(`hugo new "${directoryPath}/index.md"`, false );
  } catch (error) {
    console.error(`[Error] Failed to save page: ${error}`);
  }
}