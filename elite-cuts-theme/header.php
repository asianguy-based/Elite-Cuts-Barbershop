<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
    <meta charset="<?php bloginfo('charset'); ?>">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>

<!-- Header -->
<header>
    <div class="container nav-container">
        <?php if (has_custom_logo()) : ?>
            <?php the_custom_logo(); ?>
        <?php else : ?>
            <a href="<?php echo esc_url(home_url('/')); ?>" class="logo">
                Elite<span>Cuts</span>
            </a>
        <?php endif; ?>
        
        <nav>
            <?php
            wp_nav_menu(array(
                'theme_location' => 'primary',
                'container' => false,
                'menu_class' => '',
                'fallback_cb' => 'elitecuts_default_menu',
            ));
            ?>
        </nav>
        
        <div class="auth-buttons">
            <?php if (is_user_logged_in()) : ?>
                <a href="<?php echo wp_logout_url(home_url()); ?>" class="btn btn-outline">Logout</a>
                <a href="<?php echo admin_url(); ?>" class="btn btn-primary">Dashboard</a>
            <?php else : ?>
                <a href="<?php echo wp_login_url(); ?>" class="btn btn-outline">Login</a>
                <a href="<?php echo wp_registration_url(); ?>" class="btn btn-primary">Sign Up</a>
            <?php endif; ?>
        </div>
    </div>
</header>

<?php
// Fallback menu if no menu is set
function elitecuts_default_menu() {
    echo '<ul>';
    echo '<li><a href="' . home_url('/#home') . '">Home</a></li>';
    echo '<li><a href="' . home_url('/#barbers') . '">Our Barbers</a></li>';
    echo '<li><a href="' . home_url('/#services') . '">Services</a></li>';
    echo '<li><a href="' . home_url('/#appointment') . '">Book Now</a></li>';
    echo '<li><a href="' . home_url('/#loyalty') . '">Loyalty Program</a></li>';
    echo '</ul>';
}
?>
