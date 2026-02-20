# Elite Cuts Barbershop WordPress Theme

A modern, professional WordPress theme designed specifically for barbershops with integrated booking functionality, barber profiles, and service listings.

## Features

- **Responsive Design**: Fully responsive and mobile-friendly
- **Custom Post Types**: 
  - Barbers with experience and specialties
  - Services with pricing and icons
  - Appointments (backend management)
- **Booking System**: AJAX-powered appointment booking
- **Loyalty Program Section**: Display rewards and points
- **Customizer Integration**: Easy customization of contact info and social media links
- **WordPress Native Authentication**: Uses WordPress login/registration
- **Font Awesome Icons**: Complete icon library included

## Installation

### Method 1: Via WordPress Admin

1. Download the theme as a ZIP file
2. Log in to your WordPress admin dashboard
3. Navigate to **Appearance > Themes > Add New**
4. Click **Upload Theme**
5. Choose the ZIP file and click **Install Now**
6. Click **Activate** once installation is complete

### Method 2: Via FTP

1. Extract the theme ZIP file
2. Upload the `elite-cuts-theme` folder to `/wp-content/themes/` directory
3. Log in to WordPress admin
4. Navigate to **Appearance > Themes**
5. Find "Elite Cuts Barbershop" and click **Activate**

## Setup Instructions

### 1. Configure Basic Settings

After activating the theme:

1. Go to **Appearance > Customize**
2. Set up your site identity (logo, site title, tagline)
3. Configure **Contact Information**:
   - Phone Number
   - Email Address
   - Physical Address
   - Business Hours
4. Add **Social Media** links (Facebook, Instagram, Twitter, TikTok)

### 2. Create Navigation Menu

1. Go to **Appearance > Menus**
2. Create a new menu called "Primary Menu"
3. Add the following custom links:
   - Home: `#home`
   - Our Barbers: `#barbers`
   - Services: `#services`
   - Book Now: `#appointment`
   - Loyalty Program: `#loyalty`
4. Assign the menu to the "Primary Menu" location

### 3. Add Barbers

1. Go to **Barbers > Add New Barber**
2. Enter the barber's name as the title
3. Add a description in the content editor
4. Set a featured image (barber photo)
5. In the **Barber Details** section:
   - Enter years of experience (e.g., "Master Barber with 10+ years experience")
   - Enter specialties separated by commas (e.g., "Fades, Beard Trims, Classic Cuts")
6. Click **Publish**

### 4. Add Services

1. Go to **Services > Add New Service**
2. Enter the service name as the title
3. Add a description in the content editor
4. Set a featured image (optional)
5. In the **Service Details** section:
   - Enter the price (numbers only, e.g., "35")
   - Enter Font Awesome icon class (e.g., "fas fa-cut")
6. Click **Publish**

#### Available Font Awesome Icons for Services

- Haircut: `fas fa-cut`
- Beard: `fas fa-user-tie`
- Spa/Shave: `fas fa-spa`
- Premium Service: `fas fa-crown`
- Scissors: `fas fa-scissors`
- More icons: [Font Awesome Icons](https://fontawesome.com/icons)

### 5. Set Homepage

1. Create a new page called "Home"
2. Don't add any content
3. Go to **Settings > Reading**
4. Select "A static page" for homepage display
5. Choose "Home" as your homepage
6. Save changes

### 6. Enable User Registration (Optional)

To allow customers to create accounts:

1. Go to **Settings > General**
2. Check "Anyone can register"
3. Set "New User Default Role" to "Subscriber"
4. Save changes

## Managing Appointments

All appointments are stored in the WordPress admin:

1. Go to **Appointments** in the admin menu
2. View all bookings with details:
   - Customer name and phone
   - Selected barber
   - Selected service
   - Appointment date and time
3. Edit or delete appointments as needed

## Customization

### Changing Colors

Edit the CSS variables in `style.css`:

```css
:root {
    --primary: #1a1a2e;      /* Main dark color */
    --secondary: #16213e;    /* Secondary dark color */
    --accent: #e94560;       /* Accent/highlight color */
    --light: #f8f9fa;        /* Light background */
    --dark: #212529;         /* Text color */
}
```

### Adding Custom Content

You can edit `front-page.php` to modify any section:
- Hero section text
- Why Choose Us benefits
- Loyalty program rewards

### Hero Background Image

To change the hero background image, edit line 121 in `style.css`:

```css
.hero {
    background: linear-gradient(rgba(26, 26, 46, 0.8), rgba(26, 26, 46, 0.8)), url('YOUR-IMAGE-URL-HERE');
}
```

## Recommended Plugins

While the theme works standalone, these plugins enhance functionality:

### Essential
- **Contact Form 7**: For additional contact forms
- **Yoast SEO**: For search engine optimization
- **Wordfence Security**: For security

### Optional Enhancement
- **WP Mail SMTP**: For reliable appointment confirmation emails
- **Bookly**: Advanced booking system with calendar sync
- **WooCommerce**: If you want to sell products
- **Google Maps**: Display your location

## Support & Documentation

### Troubleshooting

**Issue: Appointments not saving**
- Solution: Make sure AJAX is working. Check browser console for errors.

**Issue: Images not showing**
- Solution: Regenerate thumbnails using a plugin like "Regenerate Thumbnails"

**Issue: Menu not displaying**
- Solution: Ensure menu is created and assigned to "Primary Menu" location

### Browser Support

- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)
- Mobile browsers

## File Structure

```
elite-cuts-theme/
├── style.css           # Main stylesheet with theme info
├── functions.php       # Theme functions and features
├── header.php          # Header template
├── footer.php          # Footer template
├── front-page.php      # Homepage template
├── index.php           # Fallback template
├── single-barber.php   # Single barber template
├── js/
│   └── main.js        # JavaScript functionality
└── README.md          # This file
```

## Credits

- Font Awesome: https://fontawesome.com
- Unsplash: https://unsplash.com (sample images)

## Changelog

### Version 1.0
- Initial release
- Custom post types for Barbers and Services
- AJAX appointment booking
- Responsive design
- Customizer integration

## License

This theme is licensed under the GPL v3 or later.

---

**Theme by AsianGuy-Based**  

