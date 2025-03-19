import type { Express } from "express";
import { createServer } from "http";
import { storage } from "./storage";
import * as cheerio from "cheerio";
import { urlSchema, type InsertProduct, type Product } from "@shared/schema";
import { ZodError } from "zod";
import fetch from "node-fetch";
import { TrendyolScrapingError, URLValidationError, ProductDataError, handleError } from "./errors";
import { createObjectCsvWriter } from "csv-writer";

async function scrapeProductAttributes($: cheerio.CheerioAPI): Promise<Record<string, string>> {
  const attributes: Record<string, string> = {};

  try {
    // 1. Schema.org verilerinden özellikleri al
    $('script[type="application/ld+json"]').each((_, script) => {
      try {
        const schema = JSON.parse($(script).html() || '{}');
        if (schema.additionalProperty) {
          schema.additionalProperty.forEach((prop: any) => {
            if (prop.name && prop.unitText) {
              attributes[prop.name] = prop.unitText;
            }
          });
        }
      } catch (e) {
        console.error('Schema parse error:', e);
      }
    });

    // 2. Öne Çıkan Özellikler bölümünü bul
    $('.detail-attr-container').each((_, container) => {
      $(container).find('tr').each((_, row) => {
        const label = $(row).find('th').text().trim();
        const value = $(row).find('td').text().trim();
        if (label && value) {
          attributes[label] = value;
        }
      });
    });

    // 3. Tüm olası özellik selektörleri
    const selectors = [
      '.product-feature-list li',
      '.detail-attr-item',
      '.product-properties li',
      '.detail-border-bottom tr',
      '.product-details tr',
      '.featured-attributes-item'
    ];

    // Her bir selektör için kontrol
    selectors.forEach(selector => {
      $(selector).each((_, element) => {
        let label, value;

        // Etiket-değer çiftlerini bul
        if ($(element).find('.detail-attr-label, .property-label').length > 0) {
          label = $(element).find('.detail-attr-label, .property-label').text().trim();
          value = $(element).find('.detail-attr-value, .property-value').text().trim();
        } else if ($(element).find('th, td').length > 0) {
          label = $(element).find('th, td:first-child').text().trim();
          value = $(element).find('td:last-child').text().trim();
        } else {
          const text = $(element).text().trim();
          [label, value] = text.split(':').map(s => s.trim());
        }

        if (label && value && !attributes[label]) {
          attributes[label] = value;
        }
      });
    });

    // 4. Özel özellik alanlarını kontrol et
    const specialAttributes = {
      'Materyal': ['Materyal', 'Kumaş', 'Material'],
      'Parça Sayısı': ['Parça Sayısı', 'Adet'],
      'Renk': ['Renk', 'Color'],
      'Desen': ['Desen', 'Pattern'],
      'Yıkama Talimatı': ['Yıkama Talimatı', 'Yıkama'],
      'Menşei': ['Menşei', 'Üretim Yeri', 'Origin']
    };

    for (const [key, alternatives] of Object.entries(specialAttributes)) {
      if (!attributes[key]) {
        for (const alt of alternatives) {
          const selector = `[data-attribute="${alt}"], [data-property="${alt}"], .detail-attr-item:contains("${alt}")`;
          $(selector).each((_, el) => {
            const value = $(el).find('.detail-attr-value, .property-value').text().trim();
            if (value) {
              attributes[key] = value;
            }
          });
        }
      }
    }

    // 5. Özellik gruplarını kontrol et
    $('.featured-attributes-group').each((_, group) => {
      const groupTitle = $(group).find('.featured-attributes-title').text().trim();
      $(group).find('.featured-attributes-item').each((_, item) => {
        const label = $(item).find('.featured-attributes-label').text().trim();
        const value = $(item).find('.featured-attributes-value').text().trim();
        if (label && value) {
          attributes[label] = value;
        }
      });
    });

    console.log("Bulunan özellikler:", attributes);
    return attributes;

  } catch (error) {
    console.error("Özellik çekme hatası:", error);
    return {};
  }
}

async function scrapeTrendyolCategories($: cheerio.CheerioAPI): Promise<string[]> {
  let categories: string[] = [];

  try {
    // 1. Schema.org verilerinden breadcrumb bilgisini al
    $('script[type="application/ld+json"]').each((_, script) => {
      try {
        const schema = JSON.parse($(script).html() || '{}');
        if (schema.breadcrumb?.itemListElement) {
          const breadcrumbs = schema.breadcrumb.itemListElement
            .map((item: any) => item.name || item.item?.name)
            .filter((name: string | undefined) => name && name !== "Trendyol");

          if (breadcrumbs.length > 0) {
            categories = breadcrumbs;
          }
        }
      } catch (e) {
        console.error('Schema parse error:', e);
      }
    });

    // 2. Ana breadcrumb yolundan kategorileri al
    if (categories.length === 0) {
      categories = $(".breadcrumb-wrapper span, .product-path span, .breadcrumb li")
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(cat => cat !== ">" && cat !== "/" && cat !== "Trendyol" && cat.length > 0);
    }

    // 3. Product detail sayfasındaki kategori bilgisini al
    if (categories.length === 0) {
      const detailCategories = [];

      // Marka bilgisi
      const brand = $(".pr-new-br span, .product-brand-name, .brand-name").first().text().trim();
      if (brand) detailCategories.push(brand);

      // Ana kategori
      const mainCategory = $(".product-category-container span").first().text().trim();
      if (mainCategory) detailCategories.push(mainCategory);

      // Alt kategori ve ürün tipi
      $(".detail-category-wrapper span, .product-type-wrapper span").each((_, el) => {
        const category = $(el).text().trim();
        if (category && !detailCategories.includes(category)) {
          detailCategories.push(category);
        }
      });

      if (detailCategories.length > 0) {
        categories = detailCategories;
      }
    }

    // 4. Giyim/tekstil/spor kategorileri için özel kontrol
    if (categories.length === 0) {
      const productTitle = $(".pr-new-br").text().trim();
      const type = $(".product-type, .type-name").first().text().trim();
      const gender = productTitle.match(/(erkek|kadın|unisex|çocuk)/i)?.[0];

      if (gender || type) {
        const categoryParts = [];
        if (gender) categoryParts.push(gender.charAt(0).toUpperCase() + gender.slice(1));
        if (type) categoryParts.push(type);

        // Ürün tipini belirle
        const productTypes = ['Giyim', 'Spor', 'Ayakkabı', 'Aksesuar'];
        for (const pType of productTypes) {
          if (productTitle.toLowerCase().includes(pType.toLowerCase())) {
            if (!categoryParts.includes(pType)) categoryParts.push(pType);
          }
        }

        if (categoryParts.length > 0) {
          categories = categoryParts;
        }
      }
    }

    // 5. Son kontrol - hala kategori bulunamadıysa
    if (categories.length === 0) {
      const title = $("h1.pr-new-br").text().trim();
      if (title) {
        categories = [title];
      } else {
        categories = ["Giyim"]; // Varsayılan kategori
      }
    }

    console.log("Bulunan kategoriler:", categories);
    return categories;

  } catch (error) {
    console.error("Kategori çekme hatası:", error);
    return ["Giyim"]; // Hata durumunda varsayılan kategori
  }
}


// Fiyat çekme fonksiyonunu ekleyelim
async function scrapePrice($: cheerio.CheerioAPI): Promise<{ price: string, basePrice: string }> {
  try {
    // 1. Schema.org verilerinden fiyat bilgisini al
    const schemaData = $('script[type="application/ld+json"]').first().html();
    if (schemaData) {
      const schema = JSON.parse(schemaData);
      if (schema.offers?.price) {
        const basePrice = schema.offers.price.toString();
        const price = (parseFloat(basePrice) * 1.15).toFixed(2); // %15 kar marjı
        return { price, basePrice };
      }
    }

    // 2. DOM'dan fiyat bilgisini al
    const priceEl = $('.prc-dsc, .product-price-container .current-price');
    if (priceEl.length > 0) {
      const basePrice = priceEl.first().text().trim().replace('TL', '').trim();
      const price = (parseFloat(basePrice) * 1.15).toFixed(2); // %15 kar marjı
      return { price, basePrice };
    }

    // 3. Alternatif fiyat selektörleri
    const altPriceEl = $('.product-price, .discounted-price');
    if (altPriceEl.length > 0) {
      const basePrice = altPriceEl.first().text().trim().replace('TL', '').trim();
      const price = (parseFloat(basePrice) * 1.15).toFixed(2); // %15 kar marjı
      return { price, basePrice };
    }

    throw new Error('Fiyat bilgisi bulunamadı');
  } catch (error) {
    console.error('Fiyat çekme hatası:', error);
    throw error;
  }
}

//Varyant çekme fonksiyonu
async function scrapeVariants($: cheerio.CheerioAPI, schema: any): Promise<{ sizes: string[], colors: string[] }> {
  const variants = {
    sizes: [] as string[],
    colors: [] as string[]
  };

  try {
    console.log("Varyant çekme başladı");

    // 1. Beden varyantlarını çek
    const sizeSelectors = [
      '.sp-itm:not(.so)',                    // Ana beden seçici
      '.variant-list-item:not(.disabled)',   // Alternatif beden seçici
      '.size-variant-wrapper:not(.disabled)', // Boyut varyant seçici
      '.v2-size-value'                       // v2 beden değeri seçici
    ];

    for (const selector of sizeSelectors) {
      let foundSizes = $(selector)
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);

      if (foundSizes.length > 0) {
        // Birleşik bedenleri parse et
        const parsedSizes = foundSizes.reduce((acc: string[], size) => {
          // XSSMLXL2XL gibi birleşik bedenleri algıla
          if (size.includes('XS') && size.includes('S') && size.includes('M')) {
            // Birleşik bedeni atla
            return acc;
          }
          // Tekil bedenleri ekle
          return [...acc, size];
        }, []);

        // Tekrar eden bedenleri kaldır ve sırala
        const uniqueSizes = [...new Set(parsedSizes)].sort((a, b) => {
          const sizeOrder = {
            'XXS': 1, 'XS': 2, 'S': 3, 'M': 4, 'L': 5, 'XL': 6,
            '2XL': 7, '3XL': 8, '4XL': 9, '5XL': 10, '6XL': 11
          };
          return (sizeOrder[a as keyof typeof sizeOrder] || 99) - (sizeOrder[b as keyof typeof sizeOrder] || 99);
        });

        if (uniqueSizes.length > 0) {
          console.log(`${selector} den bulunan bedenler:`, uniqueSizes);
          variants.sizes = uniqueSizes;
          break;
        }
      }
    }

    // 2. Renk varyantlarını çek
    const colorSelectors = [
      '.slc-txt',                         // Ana renk seçici
      '.color-variant-wrapper',           // Renk varyant seçici
      '.variant-property-list span',      // Varyant özellik listesi
      '[data-pk="color"] .variant-list-item' // Renk data attribute
    ];

    for (const selector of colorSelectors) {
      const colors = $(selector)
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);

      if (colors.length > 0) {
        console.log(`${selector} den bulunan renkler:`, colors);
        variants.colors = [...new Set(colors)]; // Tekrar eden renkleri kaldır
        break;
      }
    }

    // 3. Schema.org verilerinden varyantları kontrol et
    if (schema.hasVariant) {
      console.log("Schema.org varyant verisi bulundu");
      schema.hasVariant.forEach((variant: any) => {
        if (variant.size && !variants.sizes.includes(variant.size)) {
          variants.sizes.push(variant.size);
        }
        if (variant.color && !variants.colors.includes(variant.color)) {
          variants.colors.push(variant.color);
        }
      });
    }

    console.log("Final varyant verileri:", variants);
    return variants;

  } catch (error) {
    console.error("Varyant çekme hatası:", error);
    return variants;
  }
}

// Ana scrape fonksiyonunda fiyat çekme kısmını güncelleyelim
export async function registerRoutes(app: Express) {
  const httpServer = createServer(app);

  app.post("/api/scrape", async (req, res) => {
    try {
      console.log("Scraping başlatıldı:", req.body);
      const { url } = urlSchema.parse(req.body);

      // Cache kontrolü
      const existing = await storage.getProduct(url);
      if (existing) {
        console.log("Ürün cache'den alındı:", existing.id);
        return res.json(existing);
      }

      // Trendyol'dan veri çekme
      console.log("Trendyol'dan veri çekiliyor:", url);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (!response.ok) {
        throw new TrendyolScrapingError("Ürün sayfası yüklenemedi", {
          status: response.status,
          statusText: response.statusText
        });
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Schema.org verisi
      const schemaScript = $('script[type="application/ld+json"]').first().html();
      if (!schemaScript) {
        throw new ProductDataError("Ürün şeması bulunamadı", "schema");
      }

      let schema;
      try {
        schema = JSON.parse(schemaScript);
        if (!schema["@type"] || !schema.name) {
          throw new ProductDataError("Geçersiz ürün şeması", "schema");
        }
      } catch (error) {
        console.error("Schema parse hatası:", error);
        throw new ProductDataError("Ürün şeması geçersiz", "schema");
      }

      // Temel ürün bilgileri
      const title = schema.name;
      const description = schema.description;
      const { price, basePrice } = await scrapePrice($);

      const brand = schema.brand?.name || schema.manufacturer || title.split(' ')[0];

      if (!title || !description || !price) {
        throw new ProductDataError("Temel ürün bilgileri eksik", "basicInfo");
      }

      // Kategori ve diğer bilgileri çek
      let categories = await scrapeTrendyolCategories($);
      const attributes = await scrapeProductAttributes($);

      // Görseller
      let images: string[] = [];
      try {
        if (schema.image?.contentUrl) {
          images = Array.isArray(schema.image.contentUrl)
            ? schema.image.contentUrl
            : [schema.image.contentUrl];
        }

        if (images.length === 0) {
          const mainImage = $("img.detail-section-img").first().attr("src");
          if (mainImage) images.push(mainImage);

          $("div.gallery-modal-content img").each((_, el) => {
            const src = $(el).attr("src");
            if (src && !images.includes(src)) {
              images.push(src);
            }
          });
        }

        if (images.length === 0) {
          throw new ProductDataError("Ürün görselleri bulunamadı", "images");
        }
      } catch (error) {
        console.error("Görsel çekme hatası:", error);
        throw new ProductDataError("Görseller işlenirken hata oluştu", "images");
      }

      // Varyantları çek
      const variants = await scrapeVariants($, schema);


      const product: InsertProduct = {
        url,
        title,
        description,
        price,
        basePrice,
        images,
        variants,
        attributes,
        categories,
        tags: [...categories],
        brand
      };

      console.log("Ürün veritabanına kaydediliyor");
      const saved = await storage.saveProduct(product);
      console.log("Ürün başarıyla kaydedildi:", saved.id);
      res.json(saved);

    } catch (error) {
      console.error("Hata oluştu:", error);
      const { status, message, details } = handleError(error);
      res.status(status).json({ message, details });
    }
  });

  async function exportToShopify(product: Product) {
    const handle = product.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // Ürün özelliklerini düzenli formatla
    const attributesHtml = Object.entries(product.attributes)
      .map(([key, value]) => `<strong>${key}:</strong> ${value}`)
      .join('<br>');

    // Ana ürün kaydı
    const mainRecord = {
      'Title': product.title,
      'Handle': handle,
      'Body (HTML)': `<div class="product-features">
        <h3>Ürün Özellikleri</h3>
        <div class="features-list">
          ${attributesHtml}
        </div>
      </div>`.replace(/"/g, '""'),
      'Vendor': product.brand || '',
      'Product Category': 'Apparel & Accessories > Clothing',
      'Type': 'Clothing',
      'Tags': product.categories.join(','),
      'Published': 'TRUE',
      'Status': 'active',
      'SKU': `${handle}-1`,
      'Barcode': '',
      'Option1 Name': product.variants.sizes.length > 0 ? 'Size' : '',
      'Option1 Value': product.variants.sizes[0] || '',
      'Option2 Name': product.variants.colors.length > 0 ? 'Color' : '',
      'Option2 Value': product.variants.colors[0] || '',
      'Option3 Name': '',
      'Option3 Value': '',
      'Price': product.price,
      'Inventory policy': 'deny',
      'Inventory quantity': '100',
      'Requires shipping': 'TRUE',
      'Weight': '500',
      'Weight unit': 'g',
      'Image Src': product.images[0] || '',
      'Image Position': '1',
      'Image alt text': product.title,
      'Variant Image': '',
      'SEO Title': product.title,
      'SEO Description': Object.entries(product.attributes)
        .map(([key, value]) => `${key}: ${value}`)
        .join('. ')
        .substring(0, 320)
        .replace(/"/g, '""')
    };

    const records = [mainRecord];

    // Varyant kayıtları - her bir varyant için tüm gerekli alanları ekle
    if (product.variants.sizes.length > 0) {
      for (let i = 1; i < product.variants.sizes.length; i++) {
        records.push({
          'Handle': handle,
          'Title': '',
          'Body (HTML)': mainRecord['Body (HTML)'],
          'Vendor': mainRecord['Vendor'],
          'Product Category': mainRecord['Product Category'],
          'Type': mainRecord['Type'],
          'Tags': mainRecord['Tags'],
          'Published': mainRecord['Published'],
          'Status': mainRecord['Status'],
          'Option1 Name': 'Size',
          'Option1 Value': product.variants.sizes[i],
          'Option2 Name': mainRecord['Option2 Name'],
          'Option2 Value': mainRecord['Option2 Value'],
          'Option3 Name': '',
          'Option3 Value': '',
          'SKU': `${handle}-size-${i}`,
          'Price': product.price,
          'Inventory policy': 'deny',
          'Inventory quantity': '100',
          'Requires shipping': 'TRUE',
          'Weight': mainRecord['Weight'],
          'Weight unit': mainRecord['Weight unit']
        });
      }
    }

    if (product.variants.colors.length > 0) {
      for (let i = 1; i < product.variants.colors.length; i++) {
        const variantImage = product.images[i] || product.images[0];
        records.push({
          'Handle': handle,
          'Title': '',
          'Body (HTML)': mainRecord['Body (HTML)'],
          'Vendor': mainRecord['Vendor'],
          'Product Category': mainRecord['Product Category'],
          'Type': mainRecord['Type'],
          'Tags': mainRecord['Tags'],
          'Published': mainRecord['Published'],
          'Status': mainRecord['Status'],
          'Option1 Name': mainRecord['Option1 Name'],
          'Option1 Value': mainRecord['Option1 Value'],
          'Option2 Name': 'Color',
          'Option2 Value': product.variants.colors[i],
          'Option3 Name': '',
          'Option3 Value': '',
          'SKU': `${handle}-color-${i}`,
          'Price': product.price,
          'Inventory policy': 'deny',
          'Inventory quantity': '100',
          'Requires shipping': 'TRUE',
          'Weight': mainRecord['Weight'],
          'Weight unit': mainRecord['Weight unit'],
          'Image Src': variantImage,
          'Image Position': (i + 1).toString(),
          'Variant Image': variantImage
        });
      }
    }

    // CSV başlıkları
    const csvWriter = createObjectCsvWriter({
      path: 'products.csv',
      header: [
        {id: 'Title', title: 'Title'},
        {id: 'Handle', title: 'Handle'},
        {id: 'Body (HTML)', title: 'Body (HTML)'},
        {id: 'Vendor', title: 'Vendor'},
        {id: 'Product Category', title: 'Product Category'},
        {id: 'Type', title: 'Type'},
        {id: 'Tags', title: 'Tags'},
        {id: 'Published', title: 'Published'},
        {id: 'Status', title: 'Status'},
        {id: 'Option1 Name', title: 'Option1 Name'},
        {id: 'Option1 Value', title: 'Option1 Value'},
        {id: 'Option2 Name', title: 'Option2 Name'},
        {id: 'Option2 Value', title: 'Option2 Value'},
        {id: 'Option3 Name', title: 'Option3 Name'},
        {id: 'Option3 Value', title: 'Option3 Value'},
        {id: 'SKU', title: 'SKU'},
        {id: 'Price', title: 'Price'},
        {id: 'Inventory policy', title: 'Inventory policy'},
        {id: 'Inventory quantity', title: 'Inventory quantity'},
        {id: 'Requires shipping', title: 'Requires shipping'},
        {id: 'Weight', title: 'Weight'},
        {id: 'Weight unit', title: 'Weight unit'},
        {id: 'Image Src', title: 'Image Src'},
        {id: 'Image Position', title: 'Image Position'},
        {id: 'Image alt text', title: 'Image alt text'},
        {id: 'Variant Image', title: 'Variant Image'},
        {id: 'SEO Title', title: 'SEO Title'},
        {id: 'SEO Description', title: 'SEO Description'}
      ]
    });

    await csvWriter.writeRecords(records);
    return 'products.csv';
  }

  // Export endpoint'i
  app.post("/api/export", async (req, res) => {
    try {
      console.log("CSV export başlatıldı");
      const { product } = req.body;

      if (!product) {
        throw new ProductDataError("Ürün verisi bulunamadı", "product");
      }

      const csvFile = await exportToShopify(product);
      res.download(csvFile);

    } catch (error) {
      console.error("CSV export hatası:", error);
      const { status, message, details } = handleError(error);
      res.status(status).json({ message, details });
    }
  });

  return httpServer;
}