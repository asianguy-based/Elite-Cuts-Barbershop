<!-- Footer -->
<footer>
    <div class="container">
        <div class="footer-container">
            <div class="footer-column">
                <h3><?php bloginfo('name'); ?></h3>
                <p style="color: #ddd; margin-bottom: 1rem;"><?php bloginfo('description'); ?></p>
                <div class="social-links">
                    <?php if (get_theme_mod('elitecuts_facebook')) : ?>
                        <a href="<?php echo esc_url(get_theme_mod('elitecuts_facebook')); ?>" target="_blank" rel="noopener"><i class="fab fa-facebook-f"></i></a>
                    <?php endif; ?>
                    <?php if (get_theme_mod('elitecuts_instagram')) : ?>
                        <a href="<?php echo esc_url(get_theme_mod('elitecuts_instagram')); ?>" target="_blank" rel="noopener"><i class="fab fa-instagram"></i></a>
                    <?php endif; ?>
                    <?php if (get_theme_mod('elitecuts_twitter')) : ?>
                        <a href="<?php echo esc_url(get_theme_mod('elitecuts_twitter')); ?>" target="_blank" rel="noopener"><i class="fab fa-twitter"></i></a>
                    <?php endif; ?>
                    <?php if (get_theme_mod('elitecuts_tiktok')) : ?>
                        <a href="<?php echo esc_url(get_theme_mod('elitecuts_tiktok')); ?>" target="_blank" rel="noopener"><i class="fab fa-tiktok"></i></a>
                    <?php endif; ?>
                </div>
            </div>
            
            <div class="footer-column">
                <h3>Quick Links</h3>
                <ul>
                    <li><a href="<?php echo home_url('/#home'); ?>">Home</a></li>
                    <li><a href="<?php echo home_url('/#barbers'); ?>">Our Barbers</a></li>
                    <li><a href="<?php echo home_url('/#services'); ?>">Services</a></li>
                    <li><a href="<?php echo home_url('/#appointment'); ?>">Book Appointment</a></li>
                </ul>
            </div>
            
            <div class="footer-column">
                <h3>Services</h3>
                <ul>
                    <?php
                    $services = get_posts(array(
                        'post_type' => 'service',
                        'posts_per_page' => 4,
                    ));
                    
                    if ($services) {
                        foreach ($services as $service) {
                            echo '<li><a href="#">' . esc_html($service->post_title) . '</a></li>';
                        }
                    } else {
                        echo '<li><a href="#">Haircuts</a></li>';
                        echo '<li><a href="#">Beard Trims</a></li>';
                        echo '<li><a href="#">Hot Towel Shaves</a></li>';
                        echo '<li><a href="#">Hair Treatments</a></li>';
                    }
                    ?>
                </ul>
            </div>
            
            <div class="footer-column">
                <h3>Contact Us</h3>
                <ul>
                    <li><i class="fas fa-map-marker-alt" style="margin-right: 0.5rem;"></i> <?php echo esc_html(get_theme_mod('elitecuts_address', '123 Barber Street, City')); ?></li>
                    <li><i class="fas fa-phone" style="margin-right: 0.5rem;"></i> <?php echo esc_html(get_theme_mod('elitecuts_phone', '(555) 123-4567')); ?></li>
                    <li><i class="fas fa-envelope" style="margin-right: 0.5rem;"></i> <?php echo esc_html(get_theme_mod('elitecuts_email', 'info@elitecuts.com')); ?></li>
                    <li><i class="fas fa-clock" style="margin-right: 0.5rem;"></i> <?php echo esc_html(get_theme_mod('elitecuts_hours', 'Mon-Sat: 9AM-7PM, Sun: 10AM-5PM')); ?></li>
                </ul>
            </div>
        </div>
        
        <div class="copyright">
            <p>&copy; <?php echo date('Y'); ?> <?php bloginfo('name'); ?>. All rights reserved.</p>
        </div>
    </div>
</footer>

<?php wp_footer(); ?>
</body>
</html>
